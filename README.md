# LSTM-model-preview-honours-project

## LSTM Showcase App

Local demo of the Champion Model (Trial #101) and Baseline BiLSTM: actual vs predicted export, residuals, metrics, CSV/Excel upload and what-if sliders.

The page reads top-left to bottom-right: headline accuracy numbers, the chart, then the what-if panel beside it. Use the site buttons, the period presets, `‹ ›` (or Shift + arrow keys) to step through time, and Random to jump to another period. Click an hour, or use the arrow keys, to inspect it. What-if changes apply to every hour in view and draw as a teal line; they stay applied while you page through time. Double-click a slider to reset it.

Run `run_showcase.bat` (or `..\Starting_Model\.venv\Scripts\python.exe app.py`). Loading takes about 30 s, then the browser opens at http://127.0.0.1:5000. Works offline; Chart.js is vendored in `static/`.

- Models and `dataset.xlsx` are read from `../Starting_Model/`. Nothing there is modified.
- Windows are built per site. Training's `create_sequences` ran over the whole sheet, so 23 test windows per site boundary mixed two sites; that is why per-site metrics here differ slightly from `trial101_evaluation_summary.json`.
- Uploads use the `dataset.xlsx` schema with weather already scaled to 0..1 (see "Upload file format" on the page).
- Slider units are converted with the MinMaxScaler ranges recovered from `analyzeData/7_Sites_WeatherData_Combined_Hourly.xlsx` (constants in `model_service.py`).
- "Zero-mask night" applies ADR 0004 (zero when target-hour irradiance is 0 or hour is 20..05, otherwise max(0, y)). Off by default, matching the reported metrics.
