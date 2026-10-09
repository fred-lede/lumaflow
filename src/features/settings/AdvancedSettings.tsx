import type { FC } from "react";

import {
  bitrateOptions,
  channelOptions,
  codecOptionsForFormat,
  frameRateOptions,
  heightOptions,
  sampleRateOptions,
  widthOptions,
  type ConversionSettings,
  type SelectOption,
} from "./useConversionSettings";

export type AdvancedSettingsProps = {
  expanded: boolean;
  settings: ConversionSettings;
  onChange: (patch: Partial<ConversionSettings>) => void;
};

export const AdvancedSettings: FC<AdvancedSettingsProps> = ({ expanded, settings, onChange }) => {
  if (!expanded) {
    return null;
  }

  const audioOutput = new Set(["mp3", "m4a", "wav", "flac", "ogg"]).has(settings.format);
  const codecOptions = codecOptionsForFormat(settings.format);
  const codecValue = settings.codec ?? "";
  const resolvedCodecOptions = codecOptions.some((option) => option.value === codecValue)
    ? codecOptions
    : [...codecOptions, { value: codecValue, label: codecValue }];

  const numberValue = (value: number | null): string => (value === null ? "" : String(value));
  const numberOrNull = (value: string): number | null => (value === "" ? null : Number(value));

  const renderSelect = (
    label: string,
    value: string,
    options: SelectOption[],
    onChangeValue: (value: string) => void,
  ) => (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChangeValue(event.target.value)}>
        {options.map((option) => (
          <option key={`${label}-${option.value}`} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="advanced-settings" id="advanced-settings-panel">
      <div className="field-grid">
        {renderSelect("Codec", codecValue, resolvedCodecOptions, (value) => onChange({ codec: value || null }))}
        {!new Set(["wav", "flac"]).has(settings.format) &&
          renderSelect("Audio bitrate", numberValue(settings.bitrate), bitrateOptions, (value) =>
            onChange({ bitrate: numberOrNull(value) }),
          )}
        {!audioOutput && (
          <>
            {renderSelect("Width", numberValue(settings.width), widthOptions, (value) =>
              onChange({ width: numberOrNull(value) }),
            )}
            {renderSelect("Height", numberValue(settings.height), heightOptions, (value) =>
              onChange({ height: numberOrNull(value) }),
            )}
            {renderSelect("Frame rate", settings.frameRate ?? "", frameRateOptions, (value) =>
              onChange({ frameRate: value || null }),
            )}
          </>
        )}
        {renderSelect("Sample rate (Hz)", numberValue(settings.sampleRate), sampleRateOptions, (value) =>
          onChange({ sampleRate: numberOrNull(value) }),
        )}
        {renderSelect("Channels", numberValue(settings.channels), channelOptions, (value) =>
          onChange({ channels: numberOrNull(value) }),
        )}
      </div>
    </div>
  );
};

export default AdvancedSettings;
