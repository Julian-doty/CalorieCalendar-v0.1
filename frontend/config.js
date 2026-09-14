// Settings for the web page. This copy points at the local backend. For a deployment, don't edit it:
// scripts/build_frontend.py writes a copy of the page to dist/ with this file generated from API_BASE_URL.
window.calorieCalendarConfig = {
    // Where the backend runs, without a trailing slash.
    apiBaseUrl: "http://127.0.0.1:8000",
};
