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
  prepare: (path: string) => Promise<void>;
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
  const mediaOperationRef = useRef<number | null>(null);
  const authorizedPathRef = useRef(new Map<string, string>());
  const pendingAuthorizationRef = useRef(new Map<string, Promise<string>>());
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
    mediaOperationRef.current = null;
    if (updateState) {
      setActivePath(null);
      setError(null);
    }
  }, []);

  const ensureAuthorizedPath = useCallback(
    (path: string): Promise<string> => {
      const authorizedPath = authorizedPathRef.current.get(path);
      if (authorizedPath) {
        return Promise.resolve(authorizedPath);
      }

      const pendingAuthorization = pendingAuthorizationRef.current.get(path);
      if (pendingAuthorization) {
        return pendingAuthorization;
      }

      const authorization = adapter.authorizeOutputPreview(path).then((authorized) => {
        authorizedPathRef.current.set(path, authorized);
        return authorized;
      });
      pendingAuthorizationRef.current.set(path, authorization);
      void authorization.then(
        () => {
          if (pendingAuthorizationRef.current.get(path) === authorization) {
            pendingAuthorizationRef.current.delete(path);
          }
        },
        () => {
          if (pendingAuthorizationRef.current.get(path) === authorization) {
            pendingAuthorizationRef.current.delete(path);
          }
        },
      );
      return authorization;
    },
    [adapter],
  );

  const prepare = useCallback(
    async (path: string): Promise<void> => {
      await ensureAuthorizedPath(path);
    },
    [ensureAuthorizedPath],
  );

  const startPlayback = useCallback(
    (path: string, authorizedPath: string, operation: number): Promise<void> => {
      if (operationRef.current !== operation) {
        return Promise.resolve();
      }

      const audio = audioRef.current;
      if (!audio) {
        return Promise.reject(new Error("Audio preview element is unavailable"));
      }

      mediaOperationRef.current = operation;
      audio.src = adapter.outputPreviewUrl(authorizedPath);
      audio.load();
      return audio.play().then(() => {
        if (operationRef.current !== operation) {
          return;
        }

        activePathRef.current = path;
        setActivePath(path);
      });
    },
    [adapter],
  );

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
        const cachedAuthorizedPath = authorizedPathRef.current.get(path);
        if (cachedAuthorizedPath) {
          await startPlayback(path, cachedAuthorizedPath, operation);
          return;
        }

        const authorizedPath = await ensureAuthorizedPath(path);
        if (operationRef.current !== operation) {
          return;
        }

        await startPlayback(path, authorizedPath, operation);
      } catch {
        if (operationRef.current !== operation) {
          return;
        }

        resetAudio();
        setError(PREVIEW_UNAVAILABLE_ERROR);
      }
    },
    [ensureAuthorizedPath, resetAudio, startPlayback],
  );

  const handleEnded = useCallback((): void => {
    operationRef.current += 1;
    resetAudio();
  }, [resetAudio]);

  const handleError = useCallback((): void => {
    if (!audioRef.current?.src || mediaOperationRef.current === null) {
      return;
    }
    operationRef.current += 1;
    resetAudio();
    setError(PREVIEW_UNAVAILABLE_ERROR);
  }, [resetAudio]);

  return { audioRef, activePath, error, prepare, play, stop, handleEnded, handleError };
}

export default useAudioPreview;
