#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProgressUpdate {
    Value(f64),
    Complete,
}

pub struct ProgressParser {
    duration_seconds: f64,
    out_time_us: Option<f64>,
    out_time_ms: Option<f64>,
    out_time: Option<f64>,
    last_progress: Option<f64>,
}

impl ProgressParser {
    pub fn new(duration_seconds: f64) -> Self {
        Self {
            duration_seconds,
            out_time_us: None,
            out_time_ms: None,
            out_time: None,
            last_progress: None,
        }
    }

    pub fn feed_line(&mut self, line: &str) -> Option<ProgressUpdate> {
        let (key, value) = line.trim().split_once('=')?;
        match key {
            "progress" if value == "continue" => self.finish_record(false),
            "progress" if value == "end" => self.finish_record(true),
            "out_time_us" => {
                self.out_time_us = value
                    .parse::<f64>()
                    .ok()
                    .map(|microseconds| microseconds / 1_000_000.0);
                None
            }
            "out_time_ms" => {
                self.out_time_ms = value
                    .parse::<f64>()
                    .ok()
                    .map(|legacy_microseconds| legacy_microseconds / 1_000_000.0);
                None
            }
            "out_time" => {
                self.out_time = parse_clock_time(value);
                None
            }
            _ => None,
        }
    }

    fn finish_record(&mut self, complete: bool) -> Option<ProgressUpdate> {
        let seconds = self.out_time_us.or(self.out_time_ms).or(self.out_time);
        self.out_time_us = None;
        self.out_time_ms = None;
        self.out_time = None;

        if complete {
            return self.deduplicate(1.0).map(|_| ProgressUpdate::Complete);
        }

        seconds
            .and_then(|seconds| self.progress(seconds))
            .and_then(|progress| self.deduplicate(progress).map(ProgressUpdate::Value))
    }

    fn progress(&self, seconds: f64) -> Option<f64> {
        if !seconds.is_finite() || self.duration_seconds <= 0.0 {
            return None;
        }
        Some((seconds / self.duration_seconds).clamp(0.0, 1.0))
    }

    fn deduplicate(&mut self, progress: f64) -> Option<f64> {
        if self.last_progress == Some(progress) {
            None
        } else {
            self.last_progress = Some(progress);
            Some(progress)
        }
    }
}

fn parse_clock_time(value: &str) -> Option<f64> {
    let mut parts = value.split(':');
    let hours = parts.next()?.parse::<f64>().ok()?;
    let minutes = parts.next()?.parse::<f64>().ok()?;
    let seconds = parts.next()?.parse::<f64>().ok()?;
    if parts.next().is_some() || hours < 0.0 || minutes < 0.0 || seconds < 0.0 {
        return None;
    }
    Some(hours * 3_600.0 + minutes * 60.0 + seconds)
}

#[cfg(test)]
mod tests {
    use super::{ProgressParser, ProgressUpdate};

    #[test]
    fn parses_ffmpeg_time_updates_as_bounded_progress() {
        let mut parser = ProgressParser::new(10.0);
        assert_eq!(parser.feed_line("out_time_us=2500000"), None);
        assert_eq!(
            parser.feed_line("progress=continue"),
            Some(ProgressUpdate::Value(0.25))
        );
        assert_eq!(parser.feed_line("out_time_us=99999999"), None);
        assert_eq!(
            parser.feed_line("progress=continue"),
            Some(ProgressUpdate::Value(1.0))
        );
    }

    #[test]
    fn parses_ffmpeg_clock_time_and_completion_marker() {
        let mut parser = ProgressParser::new(120.0);
        assert_eq!(parser.feed_line("out_time=00:01:30.500000"), None);
        assert_eq!(
            parser.feed_line("progress=continue"),
            Some(ProgressUpdate::Value(0.7541666666666667))
        );
        assert_eq!(
            parser.feed_line("progress=end"),
            Some(ProgressUpdate::Complete)
        );
    }

    #[test]
    fn emits_one_canonical_update_for_changed_progress_records() {
        let mut parser = ProgressParser::new(10.0);
        let lines = [
            "out_time_us=2500000",
            "out_time_ms=9000000",
            "out_time=00:00:08.000000",
            "progress=continue",
            "out_time_us=2500000",
            "out_time_ms=9000000",
            "out_time=00:00:08.000000",
            "progress=continue",
            "out_time_us=5000000",
            "out_time_ms=1000000",
            "out_time=00:00:02.000000",
            "progress=continue",
            "progress=end",
        ];

        let updates = lines
            .into_iter()
            .filter_map(|line| parser.feed_line(line))
            .collect::<Vec<_>>();

        assert_eq!(
            updates,
            vec![
                ProgressUpdate::Value(0.25),
                ProgressUpdate::Value(0.5),
                ProgressUpdate::Complete,
            ]
        );
    }

    #[test]
    fn ignores_unrelated_and_invalid_progress_lines() {
        let mut parser = ProgressParser::new(10.0);
        assert_eq!(parser.feed_line("frame=12"), None);
        assert_eq!(parser.feed_line("out_time_us=not-a-number"), None);
        assert_eq!(parser.feed_line("out_time=bad"), None);
    }
}
