// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAudioPreview, type AudioPreviewAdapter } from "./useAudioPreview";

type FakeAudio = HTMLAudioElement & {
  emit: (event: "ended" | "error") => void;
};

function createFakeAudio(): FakeAudio {
  const listeners = new Map<string, Set<() => void>>();
  return {
    currentTime: 0,
    src: "",
    load: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
    addEventListener: vi.fn((event: string, listener: EventListenerOrEventListenerObject) => {
      const callbacks = listeners.get(event) ?? new Set<() => void>();
      callbacks.add(listener as () => void);
      listeners.set(event, callbacks);
    }),
    removeEventListener: vi.fn(),
    emit: (event: "ended" | "error") => {
      listeners.get(event)?.forEach((listener) => listener());
    },
  } as unknown as FakeAudio;
}

function renderPreview(adapterOverrides: Partial<AudioPreviewAdapter> = {}) {
  const audio = createFakeAudio();
  const adapter: AudioPreviewAdapter = {
    authorizeOutputPreview: vi.fn(async () => "/authorized/output.mp4"),
    outputPreviewUrl: vi.fn((path: string) => `preview://${path}`),
    ...adapterOverrides,
  };
  const rendered = renderHook(() => useAudioPreview({ adapter }));
  rendered.result.current.audioRef.current = audio;
  return { ...rendered, adapter, audio };
}

describe("useAudioPreview", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("starts without an active preview", () => {
    const { result } = renderPreview();

    expect(result.current.activePath).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("authorizes and plays an mp3 through the preview URL", async () => {
    const { result, adapter, audio } = renderPreview({
      authorizeOutputPreview: vi.fn(async () => "/authorized/clip.mp3"),
    });

    await act(async () => {
      await result.current.play("/output/clip.mp3");
    });

    expect(adapter.authorizeOutputPreview).toHaveBeenCalledWith("/output/clip.mp3");
    expect(adapter.outputPreviewUrl).toHaveBeenCalledWith("/authorized/clip.mp3");
    expect(audio.src).toBe("preview:///authorized/clip.mp3");
    expect(audio.load).toHaveBeenCalledTimes(2);
    expect(audio.play).toHaveBeenCalledOnce();
    expect(result.current.activePath).toBe("/output/clip.mp3");
  });

  it("plays immediately after the output has been prepared", async () => {
    const { result, adapter, audio } = renderPreview({
      authorizeOutputPreview: vi.fn(async () => "/authorized/clip.mp3"),
    });

    await act(async () => {
      await result.current.prepare("/output/clip.mp3");
    });

    const playPromise = result.current.play("/output/clip.mp3");

    expect(adapter.authorizeOutputPreview).toHaveBeenCalledOnce();
    expect(audio.play).toHaveBeenCalledOnce();
    await act(async () => {
      await playPromise;
    });
    expect(result.current.activePath).toBe("/output/clip.mp3");
  });

  it("stops an active preview when the same path is played again", async () => {
    const { result, audio } = renderPreview();

    await act(async () => {
      await result.current.play("/output/clip.mp3");
      await result.current.play("/output/clip.mp3");
    });

    expect(audio.pause).toHaveBeenCalledTimes(2);
    expect(audio.currentTime).toBe(0);
    expect(audio.src).toBe("");
    expect(result.current.activePath).toBeNull();
  });

  it("stops and resets the active element", async () => {
    const { result, audio } = renderPreview();

    await act(async () => {
      await result.current.play("/output/clip.mp4");
    });
    act(() => result.current.stop());

    expect(audio.pause).toHaveBeenCalledTimes(2);
    expect(audio.currentTime).toBe(0);
    expect(audio.src).toBe("");
    expect(result.current.activePath).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("stops the previous preview before switching to another mp4", async () => {
    const { result, audio } = renderPreview();

    await act(async () => {
      await result.current.play("/output/first.mp4");
      await result.current.play("/output/second.mp4");
    });

    expect(audio.pause).toHaveBeenCalledTimes(2);
    expect(audio.src).toBe("preview:///authorized/output.mp4");
    expect(result.current.activePath).toBe("/output/second.mp4");
  });

  it("clears active state when playback ends", async () => {
    const { result, audio } = renderPreview();

    await act(async () => {
      await result.current.play("/output/clip.mp4");
    });
    act(() => result.current.handleEnded());

    expect(audio.pause).toHaveBeenCalledTimes(2);
    expect(audio.src).toBe("");
    expect(result.current.activePath).toBeNull();
  });

  it("resets the element and reports the exact error when audio emits an error", async () => {
    const { result, audio } = renderPreview();

    await act(async () => {
      await result.current.play("/output/clip.mp4");
    });
    act(() => result.current.handleError());

    expect(audio.pause).toHaveBeenCalledTimes(2);
    expect(audio.currentTime).toBe(0);
    expect(audio.src).toBe("");
    expect(result.current.activePath).toBeNull();
    expect(result.current.error).toBe(
      "Preview unavailable. The format or codec is not supported by this platform.",
    );
  });

  it("reports the exact unavailable error when authorization is rejected", async () => {
    const { result, audio } = renderPreview({
      authorizeOutputPreview: vi.fn(async () => {
        throw new Error("permission denied");
      }),
    });

    await act(async () => {
      await result.current.play("/output/clip.mp4");
    });

    expect(result.current.error).toBe(
      "Preview unavailable. The format or codec is not supported by this platform.",
    );
    expect(result.current.activePath).toBeNull();
    expect(audio.pause).toHaveBeenCalledTimes(2);
  });

  it("reports the exact unavailable error when playback is rejected", async () => {
    const audioPlay = vi.fn(async () => {
      throw new Error("unsupported codec");
    });
    const { result, audio } = renderPreview();
    audio.play = audioPlay;

    await act(async () => {
      await result.current.play("/output/clip.mp4");
    });

    expect(result.current.error).toBe(
      "Preview unavailable. The format or codec is not supported by this platform.",
    );
    expect(result.current.activePath).toBeNull();
    expect(audio.src).toBe("");
  });

  it("invalidates stale authorization when a newer play starts", async () => {
    let resolveFirst: ((path: string) => void) | undefined;
    const authorizeOutputPreview = vi.fn(
      (path: string) =>
        new Promise<string>((resolve) => {
          if (path.endsWith("first.mp4")) {
            resolveFirst = resolve;
          } else {
            resolve(`/authorized/${path.split("/").at(-1)}`);
          }
        }),
    );
    const { result, audio } = renderPreview({ authorizeOutputPreview });

    let firstPlay: Promise<void> | undefined;
    await act(async () => {
      firstPlay = result.current.play("/output/first.mp4");
      await Promise.resolve();
      await result.current.play("/output/second.mp4");
    });
    resolveFirst?.("/authorized/first.mp4");
    await act(async () => {
      await firstPlay;
    });

    expect(audio.src).toBe("preview:///authorized/second.mp4");
    expect(result.current.activePath).toBe("/output/second.mp4");
  });

  it("invalidates pending playback on unmount and resets audio without state updates", async () => {
    let resolveAuthorization: ((path: string) => void) | undefined;
    const authorizeOutputPreview = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveAuthorization = resolve;
        }),
    );
    const { result, adapter, audio, unmount } = renderPreview({ authorizeOutputPreview });

    let playPromise: Promise<void> | undefined;
    await act(async () => {
      playPromise = result.current.play("/output/clip.mp4");
      await Promise.resolve();
    });

    unmount();
    resolveAuthorization?.("/authorized/clip.mp4");
    await act(async () => {
      await playPromise;
    });

    expect(audio.pause).toHaveBeenCalledTimes(2);
    expect(audio.currentTime).toBe(0);
    expect(audio.src).toBe("");
    expect(adapter.outputPreviewUrl).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();
  });
});
