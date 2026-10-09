import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";

import { authorizeOutputPreview, outputPreviewUrl } from "../../shared/tauri";

const PREVIEW_UNAVAILABLE_ERROR =
  "Preview unavailable. The format or codec is not supported by this platform.";

export type AudioPreviewAdapter = {
  authorizeOutputPreview: (path: string) => Promise<string>;
  outputPreviewUrl: (path: string) => string;
};

export type AudioPreviewController = {
  audioRef: MutableRefObject<HTMLAudioElement | null>;
  activePath: string | null;
  error: string | null;
  play: (path: string) => Promise<void>;
  stop: () => void;
  handleEnded: () => void;
  handleError: () => void;
};

export type UseAudioPreviewOptions = {
  adapter?: AudioPreviewAdapter;
};

const defaultAudioPreviewAdapter: AudioPreviewAdapter = {
  authorizeOutputPreview,
  outputPreviewUrl,
};

export function useAudioPreview(
  { adapter = defaultAudioPreviewAdapter }: UseAudioPreviewOptions = {},
): AudioPreviewController {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activePathRef = useRef<string | null>(null);
  const operationRef = useRef(0);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetAudio = useCallback((updateState = true): void => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.src = "";
      audio.load();
    }
    activePathRef.current = null;
    if (updateState) {
      setActivePath(null);
      setError(null);
    }
  }, []);

  useEffect(() => {
    return () => {
      operationRef.current += 1;
      resetAudio(false);
    };
  }, [resetAudio]);

  const stop = useCallback((): void => {
    operationRef.current += 1;
    resetAudio();
  }, [resetAudio]);

  const play = useCallback(
    async (path: string): Promise<void> => {
      const shouldStop = activePathRef.current === path;
      const operation = operationRef.current + 1;
      operationRef.current = operation;
      resetAudio();
      if (shouldStop) {
        return;
      }

      try {
        const authorizedPath = await adapter.authorizeOutputPreview(path);
        if (operationRef.current !== operation) {
          return;
        }

        const audio = audioRef.current;
        if (!audio) {
          throw new Error("Audio preview element is unavailable");
        }

        audio.src = adapter.outputPreviewUrl(authorizedPath);
        audio.load();
        await audio.play();
        if (operationRef.current !== operation) {
          return;
        }

        activePathRef.current = path;
        setActivePath(path);
      } catch {
        if (operationRef.current !== operation) {
          return;
        }

        resetAudio();
        setError(PREVIEW_UNAVAILABLE_ERROR);
      }
    },
    [adapter, resetAudio],
  );

  const handleEnded = useCallback((): void => {
    operationRef.current += 1;
    resetAudio();
  }, [resetAudio]);

  const handleError = useCallback((): void => {
    operationRef.current += 1;
    resetAudio();
    setError(PREVIEW_UNAVAILABLE_ERROR);
  }, [resetAudio]);

  return { audioRef, activePath, error, play, stop, handleEnded, handleError };
}

export default useAudioPreview;
