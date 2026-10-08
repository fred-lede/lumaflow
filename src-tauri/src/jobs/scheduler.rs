use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::domain::job::{JobError, JobEvent, JobState, ProcessingKind, QueueJob, QueueSnapshot};
use crate::media::planner::ConversionPlan;

pub type EventSink = Arc<dyn Fn(JobEvent) + Send + Sync + 'static>;

#[derive(Debug, Clone)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct JobExecution {
    pub job: QueueJob,
    pub plan: ConversionPlan,
}

pub trait JobExecutor: Send + Sync + 'static {
    fn execute(
        &self,
        execution: JobExecution,
        cancellation: CancellationToken,
        emit: EventSink,
    ) -> Result<(), JobError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerError {
    DuplicateJob,
    JobNotFound,
    InvalidState,
    InvalidConcurrency,
}

struct JobRecord {
    execution: JobExecution,
}

struct RunningJob {
    cancellation: CancellationToken,
}

struct SchedulerState {
    jobs: HashMap<String, JobRecord>,
    order: Vec<String>,
    pending: VecDeque<String>,
    running: HashMap<String, RunningJob>,
    paused: bool,
    shutdown: bool,
    event_sink: EventSink,
}

struct Shared {
    state: Mutex<SchedulerState>,
    changed: Condvar,
}

pub struct Scheduler {
    shared: Arc<Shared>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

impl Scheduler {
    pub fn new(executor: Arc<dyn JobExecutor>, max_concurrency: usize) -> Self {
        let worker_count = max_concurrency.max(1);
        let shared = Arc::new(Shared {
            state: Mutex::new(SchedulerState {
                jobs: HashMap::new(),
                order: Vec::new(),
                pending: VecDeque::new(),
                running: HashMap::new(),
                paused: false,
                shutdown: false,
                event_sink: Arc::new(|_| {}),
            }),
            changed: Condvar::new(),
        });

        let mut workers = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let shared = Arc::clone(&shared);
            let executor = Arc::clone(&executor);
            workers.push(thread::spawn(move || worker_loop(shared, executor)));
        }

        Self {
            shared,
            workers: Mutex::new(workers),
        }
    }

    pub fn set_event_sink(&self, event_sink: EventSink) {
        self.shared
            .state
            .lock()
            .expect("scheduler state lock should succeed")
            .event_sink = event_sink;
    }

    pub fn enqueue(&self, mut execution: JobExecution) -> Result<(), SchedulerError> {
        let job_id = execution.job.id.clone();
        execution.job.processing_kind = Some(execution.plan.processing_kind.clone());
        execution.job.state = JobState::Queued {
            label: "Queued".to_owned(),
        };
        execution.job.progress = 0.0;
        execution.job.output_path = None;
        let event = JobEvent::StateChanged {
            job_id: job_id.clone(),
            state: execution.job.state.clone(),
        };

        let sink = {
            let mut state = self
                .shared
                .state
                .lock()
                .expect("scheduler state lock should succeed");
            if state.jobs.contains_key(&job_id) {
                return Err(SchedulerError::DuplicateJob);
            }
            state.order.push(job_id.clone());
            state.pending.push_back(job_id.clone());
            state.jobs.insert(job_id, JobRecord { execution });
            Arc::clone(&state.event_sink)
        };
        sink(event);
        self.shared.changed.notify_all();
        Ok(())
    }

    pub fn pause(&self) -> Result<(), SchedulerError> {
        self.shared
            .state
            .lock()
            .expect("scheduler state lock should succeed")
            .paused = true;
        Ok(())
    }

    pub fn resume(&self) -> Result<(), SchedulerError> {
        self.shared
            .state
            .lock()
            .expect("scheduler state lock should succeed")
            .paused = false;
        self.shared.changed.notify_all();
        Ok(())
    }

    pub fn cancel(&self, job_id: &str) -> Result<(), SchedulerError> {
        let (event, sink) = {
            let mut state = self
                .shared
                .state
                .lock()
                .expect("scheduler state lock should succeed");
            if let Some(running) = state.running.get(job_id) {
                running.cancellation.cancel();
                return Ok(());
            }

            let record = state.jobs.get_mut(job_id).ok_or(SchedulerError::JobNotFound)?;
            if !matches!(record.execution.job.state, JobState::Queued { .. }) {
                return Err(SchedulerError::InvalidState);
            }
            state.pending.retain(|pending_id| pending_id != job_id);
            let label = state
                .jobs
                .get(job_id)
                .and_then(|record| match &record.execution.job.state {
                    JobState::Queued { label } => Some(label.clone()),
                    _ => None,
                })
                .unwrap_or_else(|| "Queued".to_owned());
            let record = state.jobs.get_mut(job_id).expect("job still exists");
            record.execution.job.state = JobState::Cancelled { label };
            record.execution.job.progress = 0.0;
            (
                JobEvent::StateChanged {
                    job_id: job_id.to_owned(),
                    state: record.execution.job.state.clone(),
                },
                Arc::clone(&state.event_sink),
            )
        };
        sink(event);
        self.shared.changed.notify_all();
        Ok(())
    }

    pub fn retry(&self, job_id: &str) -> Result<(), SchedulerError> {
        let (event, sink) = {
            let mut state = self
                .shared
                .state
                .lock()
                .expect("scheduler state lock should succeed");
            let next_state = {
                let record = state.jobs.get_mut(job_id).ok_or(SchedulerError::JobNotFound)?;
                if !matches!(record.execution.job.state, JobState::Failed { .. }) {
                    return Err(SchedulerError::InvalidState);
                }
                record.execution.job.state = JobState::Queued {
                    label: "Queued".to_owned(),
                };
                record.execution.job.progress = 0.0;
                record.execution.job.output_path = None;
                record.execution.job.state.clone()
            };
            state.pending.push_back(job_id.to_owned());
            (
                JobEvent::StateChanged {
                    job_id: job_id.to_owned(),
                    state: next_state,
                },
                Arc::clone(&state.event_sink),
            )
        };
        sink(event);
        self.shared.changed.notify_all();
        Ok(())
    }

    pub fn snapshot(&self) -> QueueSnapshot {
        let state = self
            .shared
            .state
            .lock()
            .expect("scheduler state lock should succeed");
        QueueSnapshot {
            jobs: state
                .order
                .iter()
                .filter_map(|id| state.jobs.get(id).map(|record| record.execution.job.clone()))
                .collect(),
            paused: state.paused,
        }
    }

    pub fn wait_for_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .shared
            .state
            .lock()
            .expect("scheduler state lock should succeed");
        loop {
            if state.pending.is_empty() && state.running.is_empty() {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let (next, result) = self
                .shared
                .changed
                .wait_timeout(state, remaining)
                .expect("scheduler wait should succeed");
            state = next;
            if result.timed_out() {
                return state.pending.is_empty() && state.running.is_empty();
            }
        }
    }
}

impl Drop for Scheduler {
    fn drop(&mut self) {
        {
            let mut state = self
                .shared
                .state
                .lock()
                .expect("scheduler state lock should succeed");
            state.shutdown = true;
            for running in state.running.values() {
                running.cancellation.cancel();
            }
        }
        self.shared.changed.notify_all();
        let mut workers = self.workers.lock().expect("worker lock should succeed");
        for worker in workers.drain(..) {
            let _ = worker.join();
        }
    }
}

fn worker_loop(shared: Arc<Shared>, executor: Arc<dyn JobExecutor>) {
    loop {
        let (execution, cancellation, sink, processing_event) = {
            let mut state = shared.state.lock().expect("scheduler state lock should succeed");
            loop {
                if state.shutdown {
                    return;
                }
                if state.paused || state.pending.is_empty() {
                    state = shared
                        .changed
                        .wait(state)
                        .expect("scheduler wait should succeed");
                    continue;
                }
                let job_id = state.pending.pop_front().expect("pending was not empty");
                let record = state.jobs.get(&job_id).expect("pending job should exist");
                if !matches!(record.execution.job.state, JobState::Queued { .. }) {
                    continue;
                }
                let execution = record.execution.clone();
                let cancellation = CancellationToken::new();
                state.running.insert(
                    job_id.clone(),
                    RunningJob {
                        cancellation: cancellation.clone(),
                    },
                );
                let processing_state = processing_state(&execution.plan.processing_kind);
                let record = state.jobs.get_mut(&job_id).expect("job still exists");
                record.execution.job.state = processing_state.clone();
                record.execution.job.progress = 0.0;
                break (
                    execution,
                    cancellation,
                    Arc::clone(&state.event_sink),
                    JobEvent::StateChanged {
                        job_id,
                        state: processing_state,
                    },
                );
            }
        };

        sink(processing_event);
        let job_id = execution.job.id.clone();
        let progress_sink = {
            let shared = Arc::clone(&shared);
            let sink = Arc::clone(&sink);
            Arc::new(move |event: JobEvent| {
                if let JobEvent::Progress { job_id, progress } = &event {
                    if let Ok(mut state) = shared.state.lock() {
                        if let Some(record) = state.jobs.get_mut(job_id) {
                            record.execution.job.progress = progress.clamp(0.0, 1.0);
                        }
                    }
                }
                sink(event);
            }) as EventSink
        };
        let result = executor.execute(execution.clone(), cancellation.clone(), progress_sink);
        let (event, sink) = {
            let mut state = shared.state.lock().expect("scheduler state lock should succeed");
            state.running.remove(&job_id);
            let record = state.jobs.get_mut(&job_id).expect("running job should exist");
            let next_state = if cancellation.is_cancelled() {
                JobState::Cancelled {
                    label: "Cancelled".to_owned(),
                }
            } else {
                match result {
                    Ok(()) => {
                        let output_path = execution.plan.output_path.to_string_lossy().into_owned();
                        record.execution.job.output_path = Some(output_path.clone());
                        JobState::Completed {
                            label: "Completed".to_owned(),
                            output_path,
                        }
                    }
                    Err(error) => JobState::Failed {
                        label: "Failed".to_owned(),
                        error,
                    },
                }
            };
            record.execution.job.state = next_state.clone();
            record.execution.job.progress = if matches!(next_state, JobState::Completed { .. }) {
                1.0
            } else {
                record.execution.job.progress
            };
            (
                JobEvent::StateChanged {
                    job_id,
                    state: next_state,
                },
                Arc::clone(&state.event_sink),
            )
        };
        sink(event);
        shared.changed.notify_all();
    }
}

fn processing_state(kind: &ProcessingKind) -> JobState {
    match kind {
        ProcessingKind::LosslessRemux { label } => JobState::LosslessRemux {
            label: label.clone(),
        },
        ProcessingKind::LosslessAudio { label } => JobState::LosslessAudio {
            label: label.clone(),
        },
        ProcessingKind::Transcoding { label } => JobState::Transcoding {
            label: label.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Condvar, Mutex};
    use std::time::Duration;

    use crate::domain::job::{
        JobError, JobState, ProcessingKind, QueueJob,
    };
    use crate::domain::media::{MediaInfo, OutputFormat, OutputSettings, QualityPreset};
    use crate::media::planner::ConversionPlan;

    use super::{CancellationToken, JobExecution, JobExecutor, Scheduler, SchedulerError};

    struct Gate {
        open: Mutex<bool>,
        changed: Condvar,
    }

    impl Gate {
        fn new() -> Self {
            Self {
                open: Mutex::new(false),
                changed: Condvar::new(),
            }
        }

        fn wait(&self, cancellation: &CancellationToken) {
            let mut open = self.open.lock().expect("gate lock should succeed");
            while !*open && !cancellation.is_cancelled() {
                let (next, _) = self
                    .changed
                    .wait_timeout(open, Duration::from_millis(10))
                    .expect("gate wait should succeed");
                open = next;
            }
        }

        fn release(&self) {
            *self.open.lock().expect("gate lock should succeed") = true;
            self.changed.notify_all();
        }
    }

    struct RecordingExecutor {
        starts: Arc<Mutex<Vec<String>>>,
        active: Arc<AtomicUsize>,
        max_active: Arc<AtomicUsize>,
        started: Mutex<Option<mpsc::Sender<String>>>,
        gate: Option<Arc<Gate>>,
        fail_once: AtomicBool,
    }

    impl RecordingExecutor {
        fn immediate() -> Arc<Self> {
            Arc::new(Self {
                starts: Arc::new(Mutex::new(Vec::new())),
                active: Arc::new(AtomicUsize::new(0)),
                max_active: Arc::new(AtomicUsize::new(0)),
                started: Mutex::new(None),
                gate: None,
                fail_once: AtomicBool::new(false),
            })
        }

        fn blocking(started: mpsc::Sender<String>, gate: Arc<Gate>) -> Arc<Self> {
            Arc::new(Self {
                starts: Arc::new(Mutex::new(Vec::new())),
                active: Arc::new(AtomicUsize::new(0)),
                max_active: Arc::new(AtomicUsize::new(0)),
                started: Mutex::new(Some(started)),
                gate: Some(gate),
                fail_once: AtomicBool::new(false),
            })
        }

        fn fail_first() -> Arc<Self> {
            Arc::new(Self {
                starts: Arc::new(Mutex::new(Vec::new())),
                active: Arc::new(AtomicUsize::new(0)),
                max_active: Arc::new(AtomicUsize::new(0)),
                started: Mutex::new(None),
                gate: None,
                fail_once: AtomicBool::new(true),
            })
        }
    }

    impl JobExecutor for RecordingExecutor {
        fn execute(
            &self,
            execution: JobExecution,
            cancellation: CancellationToken,
            _emit: super::EventSink,
        ) -> Result<(), JobError> {
            let job_id = execution.job.id;
            self.starts
                .lock()
                .expect("starts lock should succeed")
                .push(job_id.clone());
            if let Some(sender) = self
                .started
                .lock()
                .expect("started lock should succeed")
                .as_ref()
            {
                sender.send(job_id).expect("test receiver should be alive");
            }

            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            if let Some(gate) = &self.gate {
                gate.wait(&cancellation);
            }
            self.active.fetch_sub(1, Ordering::SeqCst);

            if self.fail_once.swap(false, Ordering::SeqCst) {
                return Err(JobError {
                    code: "test_failure".to_owned(),
                    message: "the test executor failed once".to_owned(),
                    details: None,
                });
            }
            Ok(())
        }
    }

    fn job(id: &str) -> QueueJob {
        QueueJob {
            id: id.to_owned(),
            source_path: format!("/input/{id}.wav"),
            media: MediaInfo {
                path: format!("/input/{id}.wav"),
                file_name: format!("{id}.wav"),
                container: "wav".to_owned(),
                duration_seconds: 1.0,
                size_bytes: 1,
                video_streams: vec![],
                audio_streams: vec![],
                subtitle_streams: vec![],
            },
            output_settings: OutputSettings {
                output_directory: "/output".to_owned(),
                format: OutputFormat::Flac,
                quality: QualityPreset::Original,
                lossless_first: true,
                codec: None,
                bitrate_kbps: None,
                width: None,
                height: None,
                frame_rate: None,
                sample_rate_hz: None,
                channels: None,
            },
            processing_kind: Some(ProcessingKind::LosslessAudio {
                label: "Lossless audio".to_owned(),
            }),
            state: JobState::Queued {
                label: "Queued".to_owned(),
            },
            progress: 0.0,
            output_path: None,
        }
    }

    fn execution(id: &str) -> JobExecution {
        JobExecution {
            job: job(id),
            plan: ConversionPlan {
                processing_kind: ProcessingKind::LosslessAudio {
                    label: "Lossless audio".to_owned(),
                },
                output_path: PathBuf::from(format!("/output/{id}.flac")),
                ffmpeg_args: vec!["-i".into(), format!("/input/{id}.wav").into()],
            },
        }
    }

    fn scheduler(executor: Arc<RecordingExecutor>, concurrency: usize) -> Scheduler {
        Scheduler::new(executor, concurrency)
    }

    #[test]
    fn runs_jobs_in_fifo_order() {
        let executor = RecordingExecutor::immediate();
        let starts = Arc::clone(&executor.starts);
        let scheduler = scheduler(executor, 1);

        for id in ["first", "second", "third"] {
            scheduler
                .enqueue(execution(id))
                .expect("job should enqueue");
        }

        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));
        assert_eq!(
            *starts.lock().expect("starts lock should succeed"),
            vec!["first", "second", "third"]
        );
    }

    #[test]
    fn honors_configurable_concurrency() {
        let (started_tx, started_rx) = mpsc::channel();
        let gate = Arc::new(Gate::new());
        let executor = RecordingExecutor::blocking(started_tx, Arc::clone(&gate));
        let max_active = Arc::clone(&executor.max_active);
        let scheduler = scheduler(executor, 2);

        scheduler.enqueue(execution("one")).expect("job should enqueue");
        scheduler.enqueue(execution("two")).expect("job should enqueue");
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("first job should start");
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("second job should start");

        assert_eq!(max_active.load(Ordering::SeqCst), 2);
        gate.release();
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));
    }

    #[test]
    fn pause_prevents_start_until_resume() {
        let executor = RecordingExecutor::immediate();
        let starts = Arc::clone(&executor.starts);
        let scheduler = scheduler(executor, 1);

        scheduler.pause().expect("pause should succeed");
        scheduler
            .enqueue(execution("paused"))
            .expect("job should enqueue");
        std::thread::sleep(Duration::from_millis(40));
        assert!(starts.lock().expect("starts lock should succeed").is_empty());

        scheduler.resume().expect("resume should succeed");
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));
        assert_eq!(
            *starts.lock().expect("starts lock should succeed"),
            vec!["paused"]
        );
    }

    #[test]
    fn cancellation_of_queued_job_does_not_execute_it() {
        let (started_tx, started_rx) = mpsc::channel();
        let gate = Arc::new(Gate::new());
        let executor = RecordingExecutor::blocking(started_tx, Arc::clone(&gate));
        let starts = Arc::clone(&executor.starts);
        let scheduler = scheduler(executor, 1);

        scheduler.enqueue(execution("running")).expect("job should enqueue");
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("first job should start");
        scheduler.enqueue(execution("cancelled")).expect("job should enqueue");
        scheduler.cancel("cancelled").expect("queued job should cancel");
        gate.release();

        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));
        assert_eq!(
            *starts.lock().expect("starts lock should succeed"),
            vec!["running"]
        );
        let snapshot = scheduler.snapshot();
        let cancelled = snapshot
            .jobs
            .iter()
            .find(|job| job.id == "cancelled")
            .expect("cancelled job should remain visible");
        assert!(matches!(cancelled.state, JobState::Cancelled { .. }));
    }

    #[test]
    fn retries_a_failed_job_without_creating_a_second_record() {
        let executor = RecordingExecutor::fail_first();
        let starts = Arc::clone(&executor.starts);
        let scheduler = scheduler(executor, 1);
        scheduler.enqueue(execution("retry")).expect("job should enqueue");
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));
        assert!(matches!(
            scheduler.snapshot().jobs[0].state,
            JobState::Failed { .. }
        ));

        scheduler.retry("retry").expect("failed job should retry");
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));

        assert_eq!(
            *starts.lock().expect("starts lock should succeed"),
            vec!["retry", "retry"]
        );
        assert!(matches!(
            scheduler.snapshot().jobs[0].state,
            JobState::Completed { .. }
        ));
    }

    #[test]
    fn rejects_duplicate_enqueue_and_concurrent_retry() {
        let executor = RecordingExecutor::fail_first();
        let starts = Arc::clone(&executor.starts);
        let scheduler = Arc::new(scheduler(executor, 1));
        scheduler.enqueue(execution("duplicate")).expect("job should enqueue");
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));
        assert_eq!(
            scheduler.enqueue(execution("duplicate")),
            Err(SchedulerError::DuplicateJob)
        );

        let left = Arc::clone(&scheduler);
        let right = Arc::clone(&scheduler);
        let left_result = std::thread::spawn(move || left.retry("duplicate")).join().unwrap();
        let right_result = std::thread::spawn(move || right.retry("duplicate")).join().unwrap();
        assert_eq!(
            [left_result, right_result]
                .into_iter()
                .filter(Result::is_ok)
                .count(),
            1
        );
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));
        assert_eq!(
            *starts.lock().expect("starts lock should succeed"),
            vec!["duplicate", "duplicate"]
        );
        assert_eq!(scheduler.snapshot().jobs.len(), 1);
    }

    #[test]
    fn cancellation_of_running_job_wins_over_executor_result() {
        let (started_tx, started_rx) = mpsc::channel();
        let gate = Arc::new(Gate::new());
        let executor = RecordingExecutor::blocking(started_tx, Arc::clone(&gate));
        let scheduler = scheduler(executor, 1);
        scheduler.enqueue(execution("running-cancel")).expect("job should enqueue");
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("job should start");
        scheduler.cancel("running-cancel").expect("running job should cancel");
        gate.release();
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));
        assert!(matches!(
            scheduler.snapshot().jobs[0].state,
            JobState::Cancelled { .. }
        ));
    }

}
