import type { FC } from "react";

import type { ConversionSettings } from "./useConversionSettings";

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

  return (
    <div className="advanced-settings" id="advanced-settings-panel">
      <div className="field-grid">
        <label className="field">
          <span>Codec</span>
          <input
            value={settings.codec ?? ""}
            placeholder="Backend default"
            onChange={(event) => onChange({ codec: event.target.value || null })}
          />
        </label>
        <label className="field">
          <span>Bitrate (kbps)</span>
          <input
            type="number"
            min="1"
            value={settings.bitrate ?? ""}
            placeholder="Auto"
            onChange={(event) => onChange({ bitrate: event.target.value ? Number(event.target.value) : null })}
          />
        </label>
        {!audioOutput && (
          <>
            <label className="field">
              <span>Width</span>
              <input
                type="number"
                min="1"
                value={settings.width ?? ""}
                placeholder="Source"
                onChange={(event) => onChange({ width: event.target.value ? Number(event.target.value) : null })}
              />
            </label>
            <label className="field">
              <span>Height</span>
              <input
                type="number"
                min="1"
                value={settings.height ?? ""}
                placeholder="Source"
                onChange={(event) => onChange({ height: event.target.value ? Number(event.target.value) : null })}
              />
            </label>
            <label className="field">
              <span>Frame rate</span>
              <input
                value={settings.frameRate ?? ""}
                placeholder="Source"
                onChange={(event) => onChange({ frameRate: event.target.value || null })}
              />
            </label>
          </>
        )}
        <label className="field">
          <span>Sample rate (Hz)</span>
          <input
            type="number"
            min="1"
            value={settings.sampleRate ?? ""}
            placeholder="Source"
            onChange={(event) => onChange({ sampleRate: event.target.value ? Number(event.target.value) : null })}
          />
        </label>
        <label className="field">
          <span>Channels</span>
          <input
            type="number"
            min="1"
            value={settings.channels ?? ""}
            placeholder="Source"
            onChange={(event) => onChange({ channels: event.target.value ? Number(event.target.value) : null })}
          />
        </label>
      </div>
    </div>
  );
};

export default AdvancedSettings;
