use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::domain::job::{JobError, JobEvent, JobState, ProcessingKind, QueueJob, QueueSnapshot};
use crate::media::planner::ConversionPlan;

pub type EventSink = Arc<dyn Fn(JobEvent) + Send + Sync + 'static>;

pub const DEFAULT_CONCURRENCY: usize = 1;

#[derive(Debug, Clone)]
pub struct CancellationToken {
    state: Arc<Mutex<CancellationState>>,
}

#[derive(Debug, Default)]
struct CancellationState {
    requested: bool,
    commit_started: bool,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(CancellationState::default())),
        }
    }

    pub fn cancel(&self) -> bool {
        let mut state = self.state.lock().expect("cancellation lock should succeed");
        if state.commit_started {
            return false;
        }
        state.requested = true;
        true
    }

    pub fn is_cancelled(&self) -> bool {
        self.state
            .lock()
            .expect("cancellation lock should succeed")
            .requested
    }

    pub(crate) fn begin_commit(&self) -> Result<CommitGuard, ()> {
        let mut state = self.state.lock().expect("cancellation lock should succeed");
        if state.requested || state.commit_started {
            return Err(());
        }
        state.commit_started = true;
        Ok(CommitGuard {
            token: self.clone(),
            finished: false,
        })
    }

    fn finish_commit(&self) {
        let state = self.state.lock().expect("cancellation lock should succeed");
        drop(state);
    }
}

pub(crate) struct CommitGuard {
    token: CancellationToken,
    finished: bool,
}

impl CommitGuard {
    pub(crate) fn finish(mut self, _committed: bool) {
        self.token.finish_commit();
        self.finished = true;
    }
}

impl Drop for CommitGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.token.finish_commit();
        }
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

#[derive(Debug, Default)]
pub struct ExecutionOutcome {
    pub cleanup_warning: Option<JobError>,
}

pub trait JobExecutor: Send + Sync + 'static {
    fn execute(
        &self,
        execution: JobExecution,
        cancellation: CancellationToken,
        emit: EventSink,
    ) -> Result<ExecutionOutcome, JobError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerError {
    DuplicateJob,
    DestinationConflict,
    JobNotFound,
    InvalidState,
    InvalidConcurrency,
    CancellationRejected,
    InvalidOrder,
}

impl SchedulerError {
    pub fn code(self) -> &'static str {
        match self {
            Self::DuplicateJob => "duplicate_job",
            Self::DestinationConflict => "destination_conflict",
            Self::JobNotFound => "job_not_found",
            Self::InvalidState => "invalid_state",
            Self::InvalidConcurrency => "invalid_concurrency",
            Self::CancellationRejected => "cancellation_rejected",
            Self::InvalidOrder => "invalid_order",
        }
    }
}

struct JobRecord {
    execution: JobExecution,
    destination: Option<PathBuf>,
    attempt: u64,
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
    revision: u64,
    sequence: u64,
}

struct Shared {
    state: Mutex<SchedulerState>,
    changed: Condvar,
    event_dispatch: Mutex<EventDispatchState>,
}

struct EventDispatchState {
    last_sequence: u64,
    pending: BTreeMap<u64, (EventSink, JobEvent)>,
}

pub struct Scheduler {
    shared: Arc<Shared>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

impl Scheduler {
    pub fn with_default_concurrency(executor: Arc<dyn JobExecutor>) -> Self {
        Self::new(executor, DEFAULT_CONCURRENCY)
    }

    pub fn new(executor: Arc<dyn JobExecutor>, max_concurrency: usize) -> Self {
        Self::try_new(executor, max_concurrency)
            .expect("scheduler concurrency must be greater than zero")
    }

    pub fn try_new(
        executor: Arc<dyn JobExecutor>,
        max_concurrency: usize,
    ) -> Result<Self, SchedulerError> {
        if max_concurrency == 0 {
            return Err(SchedulerError::InvalidConcurrency);
        }
        let worker_count = max_concurrency;
        let shared = Arc::new(Shared {
            state: Mutex::new(SchedulerState {
                jobs: HashMap::new(),
                order: Vec::new(),
                pending: VecDeque::new(),
                running: HashMap::new(),
                paused: false,
                shutdown: false,
                event_sink: Arc::new(|_| {}),
                revision: 0,
                sequence: 0,
            }),
            changed: Condvar::new(),
            event_dispatch: Mutex::new(EventDispatchState {
                last_sequence: 0,
                pending: BTreeMap::new(),
            }),
        });

        let mut workers = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let shared = Arc::clone(&shared);
            let executor = Arc::clone(&executor);
            workers.push(thread::spawn(move || worker_loop(shared, executor)));
        }

        Ok(Self {
            shared,
            workers: Mutex::new(workers),
        })
    }

    pub fn set_event_sink(&self, event_sink: EventSink) {
        self.shared
            .state
            .lock()
            .expect("scheduler state lock should succeed")
            .event_sink = event_sink;
    }

    pub fn enqueue(&self, execution: JobExecution) -> Result<(), SchedulerError> {
        self.enqueue_batch(vec![execution])
    }

    pub fn enqueue_batch(&self, mut executions: Vec<JobExecution>) -> Result<(), SchedulerError> {
        if executions.is_empty() {
            return Ok(());
        }

        let (events, sink) = {
            let mut state = self
                .shared
                .state
                .lock()
                .expect("scheduler state lock should succeed");
            release_stale_completed_destinations(&mut state);

            let mut destinations = state
                .jobs
                .values()
                .filter_map(|record| record.destination.clone())
                .collect::<HashSet<_>>();
            let mut seen_job_ids = HashSet::new();
            let mut job_ids = Vec::with_capacity(executions.len());

            for execution in &mut executions {
                let job_id = execution.job.id.clone();
                if state.jobs.contains_key(&job_id) || !seen_job_ids.insert(job_id.clone()) {
                    return Err(SchedulerError::DuplicateJob);
                }
                execution.job.processing_kind = Some(execution.plan.processing_kind.clone());
                execution.job.state = JobState::Queued {
                    label: "Queued".to_owned(),
                };
                execution.job.progress = 0.0;
                execution.job.output_path = None;

                let destination = canonical_destination(&execution.plan.output_path);
                if !destinations.insert(destination) {
                    return Err(SchedulerError::DestinationConflict);
                }
                job_ids.push(job_id);
            }

            for execution in executions {
                let job_id = execution.job.id.clone();
                let destination = canonical_destination(&execution.plan.output_path);
                state.order.push(job_id.clone());
                state.pending.push_back(job_id.clone());
                state.jobs.insert(
                    job_id,
                    JobRecord {
                        execution,
                        destination: Some(destination),
                        attempt: 0,
                    },
                );
            }
            let events = job_ids
                .into_iter()
                .map(|job_id| {
                    let job_state = state
                        .jobs
                        .get(&job_id)
                        .expect("enqueued job should exist")
                        .execution
                        .job
                        .state
                        .clone();
                    state_event(&mut state, job_id, job_state, 0)
                })
                .collect::<Vec<_>>();
            (events, Arc::clone(&state.event_sink))
        };

        for event in events {
            dispatch_event(&self.shared, &sink, event);
        }
        self.shared.changed.notify_all();
        Ok(())
    }

    pub fn pause(&self) -> Result<(), SchedulerError> {
        let mut state = self.shared
            .state
            .lock()
            .expect("scheduler state lock should succeed");
        if !state.paused {
            state.paused = true;
            bump_revision(&mut state);
        }
        Ok(())
    }

    pub fn resume(&self) -> Result<(), SchedulerError> {
        let mut state = self.shared
            .state
            .lock()
            .expect("scheduler state lock should succeed");
        if state.paused {
            state.paused = false;
            bump_revision(&mut state);
        }
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
                if running.cancellation.cancel() {
                    return Ok(());
                }
                return Err(SchedulerError::CancellationRejected);
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
            let (next_state, attempt) = {
                let record = state.jobs.get_mut(job_id).expect("job still exists");
                record.destination = None;
                record.execution.job.state = JobState::Cancelled { label };
                record.execution.job.progress = 0.0;
                (record.execution.job.state.clone(), record.attempt)
            };
            let event = state_event(
                &mut state,
                job_id.to_owned(),
                next_state,
                attempt,
            );
            (event, Arc::clone(&state.event_sink))
        };
        dispatch_event(&self.shared, &sink, event);
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
            let (next_state, next_state_attempt) = {
                let output_path = {
                    let record = state.jobs.get(job_id).ok_or(SchedulerError::JobNotFound)?;
                    if !matches!(record.execution.job.state, JobState::Failed { .. }) {
                        return Err(SchedulerError::InvalidState);
                    }
                    record.execution.plan.output_path.clone()
                };
                release_stale_completed_destinations(&mut state);
                let destination = canonical_destination(&output_path);
                if state.jobs.iter().any(|(id, other)| {
                    id != job_id && other.destination.as_ref() == Some(&destination)
                }) {
                    return Err(SchedulerError::DestinationConflict);
                }
                let record = state.jobs.get_mut(job_id).expect("job still exists");
                record.destination = Some(destination);
                record.execution.job.state = JobState::Queued {
                    label: "Queued".to_owned(),
                };
                record.execution.job.progress = 0.0;
                record.execution.job.output_path = None;
                record.attempt += 1;
                record.execution.job.attempt = record.attempt;
                (record.execution.job.state.clone(), record.attempt)
            };
            state.pending.push_back(job_id.to_owned());
            let event = state_event(&mut state, job_id.to_owned(), next_state, next_state_attempt);
            (event, Arc::clone(&state.event_sink))
        };
        dispatch_event(&self.shared, &sink, event);
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
            revision: state.revision,
            jobs: state
                .order
                .iter()
                .filter_map(|id| state.jobs.get(id).map(|record| record.execution.job.clone()))
                .collect(),
            paused: state.paused,
        }
    }

    pub fn reorder(&self, requested_order: Vec<String>) -> Result<(), SchedulerError> {
        let mut state = self
            .shared
            .state
            .lock()
            .expect("scheduler state lock should succeed");
        let known_ids = state.jobs.keys().collect::<HashSet<_>>();
        let requested_ids = requested_order.iter().collect::<HashSet<_>>();
        if requested_order.len() != requested_ids.len() || requested_ids != known_ids {
            return Err(SchedulerError::InvalidOrder);
        }

        let queued_ids = state
            .order
            .iter()
            .filter(|id| state.jobs.get(*id).is_some_and(|record| matches!(record.execution.job.state, JobState::Queued { .. })))
            .cloned()
            .collect::<HashSet<_>>();
        let requested_queued = requested_order
            .iter()
            .filter(|id| queued_ids.contains(*id))
            .cloned()
            .collect::<Vec<_>>();
        if requested_queued.len() != queued_ids.len()
            || requested_queued.iter().cloned().collect::<HashSet<_>>() != queued_ids
        {
            return Err(SchedulerError::InvalidOrder);
        }

        let mut queued = requested_queued.into_iter();
        let next_order = state
            .order
            .iter()
            .map(|id| {
                if queued_ids.contains(id) {
                    queued.next().expect("queued order should be complete")
                } else {
                    id.clone()
                }
            })
            .collect::<Vec<_>>();
        if next_order != state.order {
            state.order = next_order;
            state.pending = state
                .order
                .iter()
                .filter(|id| state.jobs.get(*id).is_some_and(|record| matches!(record.execution.job.state, JobState::Queued { .. })))
                .cloned()
                .collect();
            bump_revision(&mut state);
        }
        Ok(())
    }

    pub fn clear_completed(&self) -> Vec<String> {
        let mut state = self
            .shared
            .state
            .lock()
            .expect("scheduler state lock should succeed");
        let completed = state
            .order
            .iter()
            .filter(|id| {
                state
                    .jobs
                    .get(*id)
                    .is_some_and(|record| {
                        matches!(record.execution.job.state, JobState::Completed { .. })
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        for job_id in &completed {
            state.jobs.remove(job_id);
        }
        let existing_ids = state.jobs.keys().cloned().collect::<HashSet<_>>();
        state.order.retain(|id| existing_ids.contains(id));
        state.pending.retain(|id| existing_ids.contains(id));
        if !completed.is_empty() {
            bump_revision(&mut state);
        }
        completed
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
                let attempt = {
                    let record = state.jobs.get_mut(&job_id).expect("job still exists");
                    record.execution.job.state = processing_state.clone();
                    record.execution.job.progress = 0.0;
                    record.attempt
                };
                let processing_event = state_event(&mut state, job_id.clone(), processing_state, attempt);
                break (
                    execution,
                    cancellation,
                    Arc::clone(&state.event_sink),
                    processing_event,
                );
            }
        };

        dispatch_event(&shared, &sink, processing_event);
        let job_id = execution.job.id.clone();
        let attempt = execution.job.attempt;
        let progress_sink = {
            let shared = Arc::clone(&shared);
            Arc::new(move |event: JobEvent| {
                let Some((event, sink)) = (|| {
                    let JobEvent::Progress { job_id, progress, .. } = event else {
                        return None;
                    };
                    let mut state = shared.state.lock().ok()?;
                    let should_emit = state.jobs.get(&job_id).is_some_and(|record| {
                        record.attempt == attempt
                            && !matches!(
                                record.execution.job.state,
                                JobState::Completed { .. } | JobState::Cancelled { .. } | JobState::Failed { .. }
                            )
                    });
                    if !should_emit {
                        return None;
                    }
                    let record = state.jobs.get_mut(&job_id)?;
                    let progress = progress.clamp(0.0, 1.0);
                    record.execution.job.progress = progress;
                    let event = progress_event(&mut state, job_id, progress, attempt);
                    Some((event, Arc::clone(&state.event_sink)))
                })() else {
                    return;
                };
                dispatch_event(&shared, &sink, event);
            }) as EventSink
        };
        let result = executor.execute(execution.clone(), cancellation.clone(), progress_sink);
        let (event, sink) = {
            let mut state = shared.state.lock().expect("scheduler state lock should succeed");
            state.running.remove(&job_id);
            let record = state.jobs.get_mut(&job_id).expect("running job should exist");
            let next_state = if cancellation.is_cancelled() {
                record.destination = None;
                JobState::Cancelled {
                    label: "Cancelled".to_owned(),
                }
            } else {
                match result {
                    Ok(outcome) => {
                        let output_path = execution.plan.output_path.to_string_lossy().into_owned();
                        record.execution.job.output_path = Some(output_path.clone());
                        record.destination = destination_entry_exists(&execution.plan.output_path)
                            .then(|| canonical_destination(&execution.plan.output_path));
                        JobState::Completed {
                            label: "Completed".to_owned(),
                            output_path,
                            warning: outcome.cleanup_warning,
                        }
                    }
                    Err(error) => {
                        record.destination = None;
                        JobState::Failed {
                            label: "Failed".to_owned(),
                            error,
                        }
                    }
                }
            };
            record.execution.job.state = next_state.clone();
            record.execution.job.progress = if matches!(next_state, JobState::Completed { .. }) {
                1.0
            } else {
                record.execution.job.progress
            };
            let attempt = record.attempt;
            let event = state_event(&mut state, job_id, next_state, attempt);
            (event, Arc::clone(&state.event_sink))
        };
        dispatch_event(&shared, &sink, event);
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

fn bump_revision(state: &mut SchedulerState) -> u64 {
    state.revision = state.revision.saturating_add(1);
    state.revision
}

fn dispatch_event(shared: &Shared, sink: &EventSink, event: JobEvent) {
    let sequence = match &event {
        JobEvent::StateChanged { sequence, .. } | JobEvent::Progress { sequence, .. } => *sequence,
    };
    let mut dispatch = shared
        .event_dispatch
        .lock()
        .expect("event dispatch lock should succeed");
    dispatch.pending.insert(sequence, (Arc::clone(sink), event));
    loop {
        let next_sequence = dispatch.last_sequence + 1;
        let Some((next_sink, next_event)) = dispatch.pending.remove(&next_sequence) else {
            break;
        };
        dispatch.last_sequence += 1;
        next_sink(next_event);
    }
}

fn state_event(
    state: &mut SchedulerState,
    job_id: String,
    job_state: JobState,
    attempt: u64,
) -> JobEvent {
    let revision = bump_revision(state);
    state.sequence = state.sequence.saturating_add(1);
    JobEvent::StateChanged {
        job_id,
        state: job_state,
        revision,
        sequence: state.sequence,
        attempt,
    }
}

fn progress_event(
    state: &mut SchedulerState,
    job_id: String,
    progress: f64,
    attempt: u64,
) -> JobEvent {
    let revision = bump_revision(state);
    state.sequence = state.sequence.saturating_add(1);
    JobEvent::Progress {
        job_id,
        progress,
        revision,
        sequence: state.sequence,
        attempt,
    }
}

fn canonical_destination(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(path))
            .unwrap_or_else(|_| path.to_owned())
    };
    let parent = absolute.parent().unwrap_or_else(|| Path::new("."));
    let parent = std::fs::canonicalize(parent).unwrap_or_else(|_| lexical_path(parent));
    parent.join(absolute.file_name().unwrap_or_default())
}

fn destination_entry_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn release_stale_completed_destinations(state: &mut SchedulerState) {
    for record in state.jobs.values_mut() {
        if matches!(record.execution.job.state, JobState::Completed { .. })
            && record
                .destination
                .as_ref()
                .is_some_and(|destination| !destination_entry_exists(destination))
        {
            record.destination = None;
        }
    }
}

fn lexical_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir | Component::Normal(_) => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Condvar, Mutex};
    use std::time::Duration;

    use crate::domain::job::{
        JobError, JobEvent, JobState, ProcessingKind, QueueJob,
    };
    use crate::domain::media::{MediaInfo, OutputFormat, OutputSettings, QualityPreset};
    use crate::media::planner::ConversionPlan;

    use super::{
        dispatch_event, CancellationToken, EventSink, ExecutionOutcome, JobExecution, JobExecutor,
        Scheduler, SchedulerError,
    };

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
        ) -> Result<ExecutionOutcome, JobError> {
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
            Ok(ExecutionOutcome::default())
        }
    }

    struct CommitExecutor {
        started: Mutex<Option<mpsc::Sender<String>>>,
        gate: Arc<Gate>,
    }

    impl JobExecutor for CommitExecutor {
        fn execute(
            &self,
            execution: JobExecution,
            cancellation: CancellationToken,
            _emit: super::EventSink,
        ) -> Result<ExecutionOutcome, JobError> {
            let commit = cancellation.begin_commit().expect("commit should begin");
            self.started
                .lock()
                .expect("started lock should succeed")
                .as_ref()
                .expect("started sender should exist")
                .send(execution.job.id)
                .expect("test receiver should be alive");
            self.gate.wait(&CancellationToken::new());
            commit.finish(true);
            Ok(ExecutionOutcome::default())
        }
    }

    struct WarningExecutor;

    impl JobExecutor for WarningExecutor {
        fn execute(
            &self,
            _execution: JobExecution,
            _cancellation: CancellationToken,
            _emit: super::EventSink,
        ) -> Result<ExecutionOutcome, JobError> {
            Ok(ExecutionOutcome {
                cleanup_warning: Some(JobError {
                    code: "temp_cleanup_failed".to_owned(),
                    message: "temporary cleanup failed after publication".to_owned(),
                    details: Some("test warning".to_owned()),
                }),
            })
        }
    }

    fn job(id: &str) -> QueueJob {
        QueueJob {
            id: id.to_owned(),
            attempt: 0,
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
    fn reorders_only_queued_jobs_and_preserves_terminal_positions() {
        let executor = RecordingExecutor::immediate();
        let scheduler = scheduler(executor, 1);
        scheduler.enqueue(execution("completed")).expect("job should enqueue");
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));

        scheduler.pause().expect("pause should succeed");
        scheduler.enqueue(execution("queued-one")).expect("job should enqueue");
        scheduler.enqueue(execution("queued-two")).expect("job should enqueue");
        scheduler
            .reorder(vec!["completed".to_owned(), "queued-two".to_owned(), "queued-one".to_owned()])
            .expect("queued jobs should reorder");

        assert_eq!(
            scheduler
                .snapshot()
                .jobs
                .iter()
                .map(|job| job.id.as_str())
                .collect::<Vec<_>>(),
            vec!["completed", "queued-two", "queued-one"]
        );
        assert_eq!(
            scheduler.reorder(vec!["completed".to_owned(), "queued-two".to_owned()]),
            Err(SchedulerError::InvalidOrder)
        );
    }

    #[test]
    fn emits_monotonic_revision_sequence_and_retry_attempt_identity() {
        let events = Arc::new(Mutex::new(Vec::<JobEvent>::new()));
        let captured = Arc::clone(&events);
        let executor = RecordingExecutor::fail_first();
        let scheduler = scheduler(executor, 1);
        scheduler.set_event_sink(Arc::new(move |event| {
            captured.lock().expect("event lock should succeed").push(event);
        }));

        scheduler.enqueue(execution("retry-metadata")).expect("job should enqueue");
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));
        scheduler.retry("retry-metadata").expect("failed job should retry");
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));

        let events = events.lock().expect("event lock should succeed");
        let sequences = events
            .iter()
            .map(|event| match event {
                JobEvent::StateChanged { sequence, .. } | JobEvent::Progress { sequence, .. } => *sequence,
            })
            .collect::<Vec<_>>();
        assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(events.iter().any(|event| matches!(event, JobEvent::StateChanged { attempt: 1, state: JobState::Queued { .. }, .. })));
        assert_eq!(scheduler.snapshot().jobs[0].attempt, 1);
    }

    #[test]
    fn buffers_out_of_order_event_delivery_until_the_sequence_gap_is_filled() {
        let scheduler = scheduler(RecordingExecutor::immediate(), 1);
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&delivered);
        let sink: EventSink = Arc::new(move |event: JobEvent| {
            let sequence = match event {
                JobEvent::StateChanged { sequence, .. } | JobEvent::Progress { sequence, .. } => sequence,
            };
            captured.lock().expect("event lock should succeed").push(sequence);
        });

        dispatch_event(
            &scheduler.shared,
            &sink,
            JobEvent::Progress {
                job_id: "job-1".to_owned(),
                progress: 0.5,
                revision: 2,
                sequence: 2,
                attempt: 0,
            },
        );
        assert!(delivered.lock().expect("event lock should succeed").is_empty());

        dispatch_event(
            &scheduler.shared,
            &sink,
            JobEvent::Progress {
                job_id: "job-1".to_owned(),
                progress: 0.25,
                revision: 1,
                sequence: 1,
                attempt: 0,
            },
        );

        assert_eq!(*delivered.lock().expect("event lock should succeed"), vec![1, 2]);
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
    fn default_constructor_limits_execution_to_one_job() {
        let (started_tx, started_rx) = mpsc::channel();
        let gate = Arc::new(Gate::new());
        let executor = RecordingExecutor::blocking(started_tx, Arc::clone(&gate));
        let scheduler = Scheduler::with_default_concurrency(executor);

        scheduler.enqueue(execution("default-one")).expect("job should enqueue");
        scheduler.enqueue(execution("default-two")).expect("job should enqueue");
        assert_eq!(
            started_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("first job should start"),
            "default-one"
        );
        assert!(started_rx.recv_timeout(Duration::from_millis(40)).is_err());

        gate.release();
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));
    }

    #[test]
    fn fallible_constructor_rejects_zero_concurrency() {
        assert!(matches!(
            Scheduler::try_new(RecordingExecutor::immediate(), 0),
            Err(SchedulerError::InvalidConcurrency)
        ));
    }

    #[test]
    fn cancellation_during_commit_is_rejected_and_job_completes() {
        let (started_tx, started_rx) = mpsc::channel();
        let gate = Arc::new(Gate::new());
        let executor = Arc::new(CommitExecutor {
            started: Mutex::new(Some(started_tx)),
            gate: Arc::clone(&gate),
        });
        let scheduler = Scheduler::with_default_concurrency(executor);
        scheduler
            .enqueue(execution("commit-race"))
            .expect("job should enqueue");
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("commit should begin");

        assert_eq!(
            scheduler.cancel("commit-race"),
            Err(SchedulerError::CancellationRejected)
        );
        gate.release();
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));
        assert!(matches!(
            scheduler.snapshot().jobs[0].state,
            JobState::Completed { .. }
        ));
    }

    #[test]
    fn rejects_same_destination_for_distinct_jobs_even_with_multiple_workers() {
        let (started_tx, started_rx) = mpsc::channel();
        let gate = Arc::new(Gate::new());
        let executor = RecordingExecutor::blocking(started_tx, Arc::clone(&gate));
        let scheduler = scheduler(executor, 2);
        scheduler
            .enqueue(execution("destination-owner"))
            .expect("first job should enqueue");
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("first job should start");

        let mut conflicting = execution("destination-conflict");
        conflicting.plan.output_path = PathBuf::from("/output/./destination-owner.flac");
        assert_eq!(
            scheduler.enqueue(conflicting),
            Err(SchedulerError::DestinationConflict)
        );

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

    #[test]
    fn failed_destination_reservation_can_be_reused_by_a_new_job() {
        let executor = RecordingExecutor::fail_first();
        let scheduler = scheduler(executor, 1);
        scheduler
            .enqueue(execution("failed-owner"))
            .expect("first job should enqueue");
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));
        assert!(matches!(
            scheduler.snapshot().jobs[0].state,
            JobState::Failed { .. }
        ));

        let mut replacement = execution("replacement");
        replacement.plan.output_path = PathBuf::from("/output/failed-owner.flac");
        scheduler
            .enqueue(replacement)
            .expect("failed job destination should be reusable");
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));
        assert!(matches!(
            scheduler.snapshot().jobs[1].state,
            JobState::Completed { .. }
        ));
    }

    #[test]
    fn cancelled_destination_reservation_can_be_reused_by_a_new_job() {
        let (started_tx, started_rx) = mpsc::channel();
        let gate = Arc::new(Gate::new());
        let executor = RecordingExecutor::blocking(started_tx, Arc::clone(&gate));
        let scheduler = scheduler(executor, 1);
        scheduler
            .enqueue(execution("cancelled-owner"))
            .expect("first job should enqueue");
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("first job should start");
        scheduler
            .cancel("cancelled-owner")
            .expect("running job should cancel");
        gate.release();
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));

        let mut replacement = execution("replacement-after-cancel");
        replacement.plan.output_path = PathBuf::from("/output/cancelled-owner.flac");
        scheduler
            .enqueue(replacement)
            .expect("cancelled job destination should be reusable");
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));
        assert!(matches!(
            scheduler.snapshot().jobs[1].state,
            JobState::Completed { .. }
        ));
    }

    #[test]
    fn completed_job_retains_cleanup_warning_metadata() {
        let scheduler = Scheduler::with_default_concurrency(Arc::new(WarningExecutor));
        scheduler
            .enqueue(execution("warning"))
            .expect("job should enqueue");
        assert!(scheduler.wait_for_idle(Duration::from_secs(1)));

        let state = &scheduler.snapshot().jobs[0].state;
        assert!(matches!(
            state,
            JobState::Completed {
                warning: Some(JobError { code, .. }),
                ..
            } if code == "temp_cleanup_failed"
        ));
    }

}
