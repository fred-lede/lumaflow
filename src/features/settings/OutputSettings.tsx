import type { FC } from "react";

import AdvancedSettings from "./AdvancedSettings";
import {
  qualityPresets,
  supportedOutputFormats,
  type ConversionSettings,
} from "./useConversionSettings";

export type OutputSettingsProps = {
  advancedOpen: boolean;
  error?: string | null;
  settings: ConversionSettings;
  onChange: (patch: Partial<ConversionSettings>) => void;
  onSelectOutputFolder: () => void;
  onToggleAdvanced: () => void;
};

export const OutputSettings: FC<OutputSettingsProps> = ({
  advancedOpen,
  error,
  settings,
  onChange,
  onSelectOutputFolder,
  onToggleAdvanced,
}) => {
  return (
    <div className="output-settings">
      <div className="field-row">
        <label className="field field--wide">
          <span>Output folder</span>
          <div className="input-with-action">
            <input value={settings.outputDirectory} readOnly placeholder="Choose a destination folder" />
            <button className="button button--secondary" type="button" onClick={onSelectOutputFolder}>
              Browse
            </button>
          </div>
        </label>
      </div>

      <div className="field-grid">
        <label className="field">
          <span>Format</span>
          <select value={settings.format} onChange={(event) => onChange({ format: event.target.value as ConversionSettings["format"] })}>
            {supportedOutputFormats.map((format) => (
              <option key={format.value} value={format.value}>
                {format.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Processing mode</span>
          <select value={settings.mode} onChange={(event) => onChange({ mode: event.target.value as ConversionSettings["mode"] })}>
            <option value="lossless-first">Lossless first</option>
            <option value="transcode">Always transcode</option>
          </select>
        </label>
      </div>

      <fieldset className="preset-fieldset">
        <legend>Quality preset</legend>
        <div className="preset-grid">
          {qualityPresets.map((preset) => (
            <label className={`preset-option${settings.preset === preset.value ? " preset-option--selected" : ""}`} key={preset.value}>
              <input
                type="radio"
                name="quality-preset"
                value={preset.value}
                checked={settings.preset === preset.value}
                onChange={() => onChange({ preset: preset.value })}
              />
              <span>
                <strong>{preset.label}</strong>
                <small>{preset.description}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <button
        className="advanced-toggle"
        type="button"
        aria-expanded={advancedOpen}
        aria-controls="advanced-settings-panel"
        onClick={onToggleAdvanced}
      >
        <span>{advancedOpen ? "Hide advanced settings" : "Show advanced settings"}</span>
        <span aria-hidden="true">{advancedOpen ? "−" : "+"}</span>
      </button>
      <AdvancedSettings expanded={advancedOpen} settings={settings} onChange={onChange} />

      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

export default OutputSettings;
