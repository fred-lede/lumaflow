#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProgressUpdate {
    Value(f64),
    Complete,
}

pub struct ProgressParser {
    duration_seconds: f64,
}

impl ProgressParser {
    pub fn new(duration_seconds: f64) -> Self {
        Self { duration_seconds }
    }

    pub fn feed_line(&mut self, line: &str) -> Option<ProgressUpdate> {
        let (key, value) = line.trim().split_once('=')?;
        match key {
            "progress" if value == "end" => Some(ProgressUpdate::Complete),
            "out_time_us" | "out_time_ms" => value
                .parse::<f64>()
                .ok()
                .and_then(|microseconds| self.value(microseconds / 1_000_000.0)),
            "out_time" => parse_clock_time(value).and_then(|seconds| self.value(seconds)),
            _ => None,
        }
    }

    fn value(&self, seconds: f64) -> Option<ProgressUpdate> {
        if !seconds.is_finite() || self.duration_seconds <= 0.0 {
            return None;
        }
        Some(ProgressUpdate::Value(
            (seconds / self.duration_seconds).clamp(0.0, 1.0),
        ))
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
        assert_eq!(parser.feed_line("out_time_us=2500000"), Some(ProgressUpdate::Value(0.25)));
        assert_eq!(parser.feed_line("out_time_us=99999999"), Some(ProgressUpdate::Value(1.0)));
    }

    #[test]
    fn parses_ffmpeg_clock_time_and_completion_marker() {
        let mut parser = ProgressParser::new(120.0);
        assert_eq!(
            parser.feed_line("out_time=00:01:30.500000"),
            Some(ProgressUpdate::Value(0.7541666666666667))
        );
        assert_eq!(parser.feed_line("progress=end"), Some(ProgressUpdate::Complete));
    }

    #[test]
    fn ignores_unrelated_and_invalid_progress_lines() {
        let mut parser = ProgressParser::new(10.0);
        assert_eq!(parser.feed_line("frame=12"), None);
        assert_eq!(parser.feed_line("out_time_us=not-a-number"), None);
        assert_eq!(parser.feed_line("out_time=bad"), None);
    }
}
