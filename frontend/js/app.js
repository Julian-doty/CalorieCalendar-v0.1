const logPrefix = "[calorieCalendar]";
// Set in config.js, which deployments generate with scripts/build_frontend.py; the local backend is the fallback.
const apiBaseUrl = (window.calorieCalendarConfig?.apiBaseUrl || "http://127.0.0.1:8000").replace(/\/+$/, "");
// Longer than the backend's own 10 s Open Food Facts timeout, so its 504 message wins.
const searchTimeoutMs = 15000;

// IndexedDB schema: one "entries" store keyed by an auto-incremented id, with a "date" index.
// To change it, bump databaseVersion and add a migration step in openDatabase().
const databaseName = "calorieCalendar";
const databaseVersion = 1;
const entriesStoreName = "entries";

const searchForm = document.getElementById("searchForm");
const searchFoodNameInput = document.getElementById("searchFoodName");
const searchAmountInput = document.getElementById("searchAmount");
const searchButton = document.getElementById("searchButton");
const searchStatus = document.getElementById("searchStatus");
const searchResults = document.getElementById("searchResults");
const searchResultsBody = document.getElementById("searchResultsBody");

const entryForm = document.getElementById("entryForm");
const entryDateInput = document.getElementById("entryDate");
const entryFoodItemInput = document.getElementById("entryFoodItem");
const entryCaloriesInput = document.getElementById("entryCalories");
const entrySubmitButton = document.getElementById("entrySubmitButton");
const storageStatus = document.getElementById("storageStatus");
const entriesTableBody = document.getElementById("entriesTableBody");
const emptyStateRow = document.getElementById("emptyStateRow");

// Entries shown in the table: everything loaded from or saved to IndexedDB, plus unsaved
// entries when storage isn't available.
const entries = [];
// The open IndexedDB connection; stays null when the browser can't provide storage.
let database = null;

function getTodayIsoDate() {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    return `${today.getFullYear()}-${month}-${day}`;
}

function createCell(text) {
    const cell = document.createElement("td");
    cell.textContent = text;
    return cell;
}

function formatNumber(value, unit = "") {
    if (typeof value !== "number") {
        return "—";
    }
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit}`;
}

function pluralize(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}

function setStatus(element, message, isError = false) {
    element.textContent = message;
    element.classList.toggle("statusError", isError);
}

// --- Food search ---

function setSearchLoading(isLoading) {
    searchButton.disabled = isLoading;
    searchButton.setAttribute("aria-busy", String(isLoading));
    searchButton.textContent = isLoading ? "Searching…" : "Search";
}

function getSearchErrorMessage(status, body) {
    // Backend errors (502/503/504) carry a readable "detail" string; validation errors (422) carry a list.
    if (typeof body?.detail === "string") {
        return body.detail;
    }
    if (status === 422) {
        return "Enter a food name between 1 and 100 characters.";
    }
    return `The search failed (HTTP ${status}).`;
}

async function requestFoodSearch(foodName) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), searchTimeoutMs);

    try {
        const response = await fetch(`${apiBaseUrl}/search-food`, {
            method: "POST",
            // With a login token, the backend gives Open Food Facts the user's email as the contact address.
            headers: { "Content-Type": "application/json", ...getOptionalAuthorizationHeader() },
            body: JSON.stringify({ foodName }),
            signal: controller.signal,
        });
        const body = await response.json().catch((error) => {
            if (error.name === "AbortError") {
                throw error;
            }
            return null;
        });
        console.log(logPrefix, `POST /search-food -> HTTP ${response.status}`, body);

        if (!response.ok) {
            throw new Error(getSearchErrorMessage(response.status, body));
        }
        if (!Array.isArray(body?.products)) {
            throw new Error("The backend sent an unexpected response.");
        }
        return body.products.filter((product) => typeof product?.productName === "string");
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error("The search took too long. Try again.", { cause: error });
        }
        // fetch rejects with a TypeError when the backend is down or CORS blocks the request.
        if (error instanceof TypeError) {
            throw new Error(`Couldn't reach the backend at ${apiBaseUrl}. Is it running?`, { cause: error });
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

function useProduct(product) {
    if (!searchAmountInput.reportValidity()) {
        return;
    }
    const amount = searchAmountInput.valueAsNumber;
    const calories = Math.round((product.caloriesPer100g * amount) / 100);

    entryFoodItemInput.value = `${product.productName} (${amount} g)`;
    entryCaloriesInput.value = calories;
    entryFoodItemInput.removeAttribute("aria-invalid");
    entryCaloriesInput.removeAttribute("aria-invalid");
    entryCaloriesInput.focus();

    setStatus(
        searchStatus,
        `Filled in ${product.productName} (${amount} g, ${calories.toLocaleString()} kcal). Check the date, then add the entry.`,
    );
    console.log(logPrefix, "Used product:", { productName: product.productName, amount, calories });
}

function createProductRow(product) {
    const hasImage = typeof product.imageUrl === "string" && product.imageUrl.startsWith("https://");
    const thumbnail = document.createElement(hasImage ? "img" : "div");
    thumbnail.className = "productThumbnail";
    if (hasImage) {
        thumbnail.src = product.imageUrl;
        thumbnail.alt = "";
        thumbnail.loading = "lazy";
    }

    const name = document.createElement("span");
    name.textContent = product.productName;

    const productInfo = document.createElement("div");
    productInfo.className = "productInfo";
    productInfo.append(thumbnail, name);

    const productCell = document.createElement("td");
    productCell.append(productInfo);

    const useButton = document.createElement("button");
    useButton.type = "button";
    useButton.className = "outline";
    useButton.textContent = "Use";
    useButton.setAttribute("aria-label", `Use ${product.productName}`);
    // Without calorie data there's nothing to fill in.
    useButton.disabled = typeof product.caloriesPer100g !== "number";
    useButton.addEventListener("click", () => useProduct(product));

    const actionCell = document.createElement("td");
    actionCell.append(useButton);

    const macronutrients = product.macronutrientsPer100g ?? {};
    const row = document.createElement("tr");
    row.append(
        productCell,
        createCell(formatNumber(product.caloriesPer100g)),
        createCell(formatNumber(macronutrients.protein, " g")),
        createCell(formatNumber(macronutrients.fat, " g")),
        createCell(formatNumber(macronutrients.carbs, " g")),
        actionCell,
    );
    return row;
}

function renderSearchResults(products, foodName) {
    // Products with calorie data first; the sort is stable, so relevance order holds within each group.
    const lacksCalories = (product) => Number(typeof product.caloriesPer100g !== "number");
    const sortedProducts = [...products].sort((a, b) => lacksCalories(a) - lacksCalories(b));

    searchResultsBody.replaceChildren(...sortedProducts.map(createProductRow));
    searchResults.hidden = products.length === 0;

    if (products.length === 0) {
        setStatus(searchStatus, `No products found for "${foodName}".`);
    } else {
        setStatus(searchStatus, `Found ${pluralize(products.length, "product")} for "${foodName}". Pick one to fill in the entry form.`);
    }
    console.log(logPrefix, `Rendered ${products.length} search results`);
}

async function handleSearchSubmit(event) {
    event.preventDefault();
    const foodName = searchFoodNameInput.value.trim();

    console.log(logPrefix, "Searching for:", foodName);
    setSearchLoading(true);
    setStatus(searchStatus, `Searching for "${foodName}"…`);

    try {
        const products = await requestFoodSearch(foodName);
        renderSearchResults(products, foodName);
    } catch (error) {
        searchResultsBody.replaceChildren();
        searchResults.hidden = true;
        setStatus(searchStatus, error.message, true);
        console.error(logPrefix, "Search failed:", error);
    } finally {
        setSearchLoading(false);
    }
}

// --- Entry storage (IndexedDB) ---

function openDatabase() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
            reject(new Error("this browser doesn't support IndexedDB"));
            return;
        }
        // open() can throw (e.g. SecurityError when storage is blocked); a throw here rejects the promise.
        const request = indexedDB.open(databaseName, databaseVersion);

        request.onupgradeneeded = (event) => {
            if (event.oldVersion < 1) {
                const entriesStore = request.result.createObjectStore(entriesStoreName, {
                    keyPath: "id",
                    autoIncrement: true,
                });
                entriesStore.createIndex("date", "date");
            }
        };
        request.onblocked = () => {
            setStatus(storageStatus, "Waiting for other Calorie Calendar tabs to close so saved entries can load…");
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const openedDatabase = request.result;
            // A newer version is opening in another tab: close so its upgrade can run.
            openedDatabase.onversionchange = () => {
                openedDatabase.close();
                console.warn(logPrefix, "Closed the database so another tab can upgrade it");
                setStatus(storageStatus, "Calorie Calendar was updated in another tab. Reload this page to keep saving entries.", true);
            };
            resolve(openedDatabase);
        };
    });
}

// Resolves with the request's result once the whole transaction has committed.
function runEntriesRequest(mode, createRequest) {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(entriesStoreName, mode);
        const request = createRequest(transaction.objectStore(entriesStoreName));
        transaction.oncomplete = () => resolve(request.result);
        // A failed request aborts its transaction, so this also covers request errors.
        transaction.onabort = () => reject(transaction.error ?? new DOMException("The transaction was aborted.", "AbortError"));
    });
}

function readStoredEntries() {
    return runEntriesRequest("readonly", (store) => store.getAll());
}

function storeEntry(entry) {
    return runEntriesRequest("readwrite", (store) => store.add(entry));
}

function isValidStoredEntry(record) {
    return (
        typeof record?.id === "number" &&
        typeof record.date === "string" &&
        typeof record.foodItem === "string" &&
        Number.isFinite(record.calories) &&
        typeof record.createdAt === "string"
    );
}

function describeStorageError(error) {
    switch (error?.name) {
        case "QuotaExceededError":
            return "the browser's storage is full";
        case "InvalidStateError":
            return "the database connection was closed; reload the page";
        case "SecurityError":
            return "the browser is blocking storage for this page";
        case "VersionError":
            return "the saved data is from a newer version of Calorie Calendar";
        default:
            // Browser messages usually end with a period; drop it so the text reads well inside parentheses.
            return error?.message?.replace(/\.$/, "") || "unknown error";
    }
}

async function openStorage() {
    try {
        database = await openDatabase();
        console.log(logPrefix, `Opened IndexedDB "${databaseName}" version ${database.version}`);
        return true;
    } catch (error) {
        console.error(logPrefix, "Could not open IndexedDB:", error);
        setStatus(
            storageStatus,
            `Entries can't be saved in this browser (${describeStorageError(error)}). New entries will be lost when you reload.`,
            true,
        );
        return false;
    }
}

async function loadStoredEntries() {
    try {
        const records = await readStoredEntries();
        const validRecords = records.filter(isValidStoredEntry);
        if (validRecords.length < records.length) {
            console.warn(logPrefix, `Skipped ${records.length - validRecords.length} malformed stored entries`);
        }
        entries.push(...validRecords.map((record) => ({ ...record, isSaved: true })));
        console.log(logPrefix, `Loaded ${validRecords.length} stored entries`);
        setStatus(
            storageStatus,
            validRecords.length === 0
                ? "No saved entries yet. Entries you add are saved in this browser."
                : `Loaded ${pluralize(validRecords.length, "saved entry", "saved entries")} from this browser.`,
        );
    } catch (error) {
        console.error(logPrefix, "Could not load stored entries:", error);
        setStatus(storageStatus, `Couldn't load saved entries (${describeStorageError(error)}). New entries will still be saved.`, true);
    }
}

async function initializeStorage() {
    if (await openStorage()) {
        await loadStoredEntries();
    }
    renderEntries();
    setEntryButtonBusy(false);
}

// --- Entries ---

function setEntryButtonBusy(isBusy, busyLabel = "Saving…") {
    entrySubmitButton.disabled = isBusy;
    entrySubmitButton.setAttribute("aria-busy", String(isBusy));
    entrySubmitButton.textContent = isBusy ? busyLabel : "Add entry";
}

function createStorageBadge(isSaved) {
    const badge = document.createElement("span");
    badge.className = `storageBadge ${isSaved ? "storageSaved" : "storageNotSaved"}`;
    badge.textContent = isSaved ? "✓ Saved" : "Not saved";
    return badge;
}

function createEntryRow(entry) {
    const storageCell = document.createElement("td");
    storageCell.append(createStorageBadge(entry.isSaved));

    const row = document.createElement("tr");
    row.append(
        createCell(entry.date),
        createCell(entry.foodItem),
        createCell(entry.calories.toLocaleString()),
        storageCell,
    );
    return row;
}

function renderEntries() {
    if (entries.length === 0) {
        emptyStateRow.hidden = false;
        entriesTableBody.replaceChildren(emptyStateRow);
    } else {
        // Newest date first; within a date, most recently added first.
        const sortedEntries = [...entries].sort(
            (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
        );
        entriesTableBody.replaceChildren(...sortedEntries.map(createEntryRow));
    }
    console.log(logPrefix, `Rendered ${entries.length} entries`);
}

async function handleEntrySubmit(event) {
    event.preventDefault();

    const entry = {
        date: entryDateInput.value,
        foodItem: entryFoodItemInput.value.trim(),
        calories: entryCaloriesInput.valueAsNumber,
        createdAt: new Date().toISOString(),
    };
    const isSaved = database !== null;

    if (isSaved) {
        setEntryButtonBusy(true);
        try {
            entry.id = await storeEntry(entry);
        } catch (error) {
            console.error(logPrefix, "Could not save entry:", error);
            setStatus(
                storageStatus,
                `Couldn't save "${entry.foodItem}" (${describeStorageError(error)}). It's still in the form, so you can try again.`,
                true,
            );
            return;
        } finally {
            setEntryButtonBusy(false);
        }
        setStatus(storageStatus, `Saved "${entry.foodItem}" in this browser.`);
    } else {
        setStatus(storageStatus, `Added "${entry.foodItem}", but it isn't saved and will be lost when you reload.`, true);
    }

    entries.push({ ...entry, isSaved });
    console.log(logPrefix, isSaved ? "Saved entry:" : "Added unsaved entry:", entry);
    renderEntries();

    // Keep the date so several items for the same day can be logged in a row.
    entryForm.reset();
    entryDateInput.value = entry.date;
    entryFoodItemInput.focus();
}

// --- Validation styling ---

function markFieldInvalid(event) {
    event.target.setAttribute("aria-invalid", "true");
    console.warn(logPrefix, `Invalid ${event.target.name}:`, event.target.validationMessage);
}

function clearFieldInvalid(event) {
    if (event.target.validity.valid) {
        event.target.removeAttribute("aria-invalid");
    }
}

for (const form of [searchForm, entryForm]) {
    // "invalid" doesn't bubble, so listen in the capture phase.
    form.addEventListener("invalid", markFieldInvalid, true);
    form.addEventListener("input", clearFieldInvalid);
}

searchForm.addEventListener("submit", handleSearchSubmit);
entryForm.addEventListener("submit", handleEntrySubmit);

entryDateInput.value = getTodayIsoDate();
initializeStorage();
console.log(logPrefix, "app.js loaded");

// --- Account (JWT login) ---
// Registers and logs in against the backend, keeps the token in localStorage, and sends it as a
// Bearer token to protected routes. The entry form and food search above work without it, but food
// search sends the token when there is one so the backend can name the user as the Open Food Facts contact.

const authTokenStorageKey = "calorieCalendarAuthToken";
const authForm = document.getElementById("authForm");
const authUsernameInput = document.getElementById("authUsername");
const authPasswordInput = document.getElementById("authPassword");
const authEmailInput = document.getElementById("authEmail");
const loginButton = document.getElementById("loginButton");
const registerButton = document.getElementById("registerButton");
const signedInPanel = document.getElementById("signedInPanel");
const signedInUsername = document.getElementById("signedInUsername");
const logoutButton = document.getElementById("logoutButton");
const authStatus = document.getElementById("authStatus");

// localStorage throws when the browser blocks site data, so every access is guarded.
function readStoredToken() {
    try {
        return localStorage.getItem(authTokenStorageKey);
    } catch (error) {
        console.warn(logPrefix, "Couldn't read the login token from localStorage:", error);
        return null;
    }
}

function storeToken(token) {
    try {
        localStorage.setItem(authTokenStorageKey, token);
        return true;
    } catch (error) {
        console.warn(logPrefix, "Couldn't save the login token to localStorage:", error);
        return false;
    }
}

function clearStoredToken() {
    try {
        localStorage.removeItem(authTokenStorageKey);
    } catch (error) {
        console.warn(logPrefix, "Couldn't remove the login token from localStorage:", error);
    }
}

// Reads the token's claims for display and the expiry check only; the backend verifies the signature.
function readTokenClaims(token) {
    try {
        const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
    } catch {
        return null;
    }
}

function showSignedIn(username) {
    authForm.hidden = true;
    signedInPanel.hidden = false;
    signedInUsername.textContent = username;
}

function showSignedOut() {
    authForm.hidden = false;
    signedInPanel.hidden = true;
    signedInUsername.textContent = "";
}

function setAuthBusy(activeButton, isBusy) {
    loginButton.disabled = isBusy;
    registerButton.disabled = isBusy;
    activeButton.setAttribute("aria-busy", String(isBusy));
}

function describeAuthError(status, body) {
    if (typeof body?.detail === "string") {
        return body.detail;
    }
    if (status === 422) {
        return "Use a 3 to 50 character username (letters, numbers, dots, dashes or underscores), a password of at least 6 characters and an email address like name@example.com.";
    }
    return `The request failed (HTTP ${status}).`;
}

function describeFailedRequest(error) {
    // fetch rejects with a TypeError when the backend is down or CORS blocks the request.
    return error instanceof TypeError ? `Couldn't reach the backend at ${apiBaseUrl}. Is it running?` : error.message;
}

async function postCredentials(path, extraFields = {}) {
    // URLSearchParams sends form fields, which /register and /login expect.
    const response = await fetch(`${apiBaseUrl}${path}`, {
        method: "POST",
        body: new URLSearchParams({ username: authUsernameInput.value, password: authPasswordInput.value, ...extraFields }),
    });
    const body = await response.json().catch(() => null);
    return { response, body };
}

// For routes that work with or without a login, like food search: the stored token, if there is one.
// Unlike fetchProtected it never signs the page out, because those routes simply ignore an expired token.
function getOptionalAuthorizationHeader() {
    const token = readStoredToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}

// Calls a protected backend route with the stored token in the Authorization header. Without a
// token it doesn't send the request; if the backend rejects the token (401) it clears it and signs
// the page out. Either way it throws an error with a message to show.
async function fetchProtected(path, options = {}) {
    const token = readStoredToken();
    if (!token) {
        showSignedOut();
        throw new Error("Log in to use this feature.");
    }
    const response = await fetch(`${apiBaseUrl}${path}`, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
    if (response.status === 401) {
        clearStoredToken();
        showSignedOut();
        throw new Error("Your login has expired or is no longer valid. Log in again.");
    }
    return response;
}

async function handleLogin(event) {
    event.preventDefault();
    setAuthBusy(loginButton, true);
    setStatus(authStatus, "Logging in…");
    try {
        const { response, body } = await postCredentials("/login");
        if (!response.ok || typeof body?.access_token !== "string") {
            setStatus(authStatus, describeAuthError(response.status, body), true);
            console.warn(logPrefix, `Login failed (HTTP ${response.status})`);
            return;
        }
        if (!storeToken(body.access_token)) {
            setStatus(authStatus, "This browser is blocking site storage, so the login can't be kept.", true);
            return;
        }
        const username = readTokenClaims(body.access_token)?.sub ?? authUsernameInput.value;
        authPasswordInput.value = "";
        showSignedIn(username);
        setStatus(authStatus, `Logged in as ${username}.`);
        console.log(logPrefix, "Logged in as", username);
    } catch (error) {
        setStatus(authStatus, describeFailedRequest(error), true);
        console.error(logPrefix, "Login request failed:", error);
    } finally {
        setAuthBusy(loginButton, false);
    }
}

async function handleRegister() {
    // Register isn't the submit button, so run the same field checks a submit would.
    if (!authForm.reportValidity()) {
        return;
    }
    // The email field isn't marked required because logging in doesn't use it.
    if (!authEmailInput.value) {
        authEmailInput.setAttribute("aria-invalid", "true");
        authEmailInput.focus();
        setStatus(authStatus, "Enter your email address to register.", true);
        return;
    }
    setAuthBusy(registerButton, true);
    setStatus(authStatus, "Creating the account…");
    try {
        const { response, body } = await postCredentials("/register", { email: authEmailInput.value });
        if (!response.ok) {
            setStatus(authStatus, describeAuthError(response.status, body), true);
            console.warn(logPrefix, `Registration failed (HTTP ${response.status})`);
            return;
        }
        setStatus(authStatus, `Account created for ${body?.username ?? authUsernameInput.value}. Log in to continue.`);
        console.log(logPrefix, "Registered", body?.username);
    } catch (error) {
        setStatus(authStatus, describeFailedRequest(error), true);
        console.error(logPrefix, "Registration request failed:", error);
    } finally {
        setAuthBusy(registerButton, false);
    }
}

function handleLogout() {
    clearStoredToken();
    showSignedOut();
    setStatus(authStatus, "Logged out.");
    authUsernameInput.focus();
    console.log(logPrefix, "Logged out");
}

// On page load: show a saved login straight away, then confirm it with the protected /me route.
async function restoreSession() {
    const token = readStoredToken();
    if (!token) {
        showSignedOut();
        return;
    }
    const claims = readTokenClaims(token);
    if (typeof claims?.sub !== "string" || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
        clearStoredToken();
        showSignedOut();
        setStatus(authStatus, "Your login has expired. Log in again.", true);
        console.warn(logPrefix, "Removed an expired or unreadable login token");
        return;
    }
    showSignedIn(claims.sub);
    try {
        const response = await fetchProtected("/me");
        const body = await response.json().catch(() => null);
        if (!response.ok || typeof body?.username !== "string") {
            setStatus(authStatus, describeAuthError(response.status, body), true);
            return;
        }
        showSignedIn(body.username);
        console.log(logPrefix, "Login confirmed for", body.username);
    } catch (error) {
        setStatus(authStatus, describeFailedRequest(error), true);
        console.warn(logPrefix, "Couldn't confirm the saved login:", error.message);
    }
}

authForm.addEventListener("submit", handleLogin);
authForm.addEventListener("invalid", markFieldInvalid, true);
authForm.addEventListener("input", clearFieldInvalid);
registerButton.addEventListener("click", handleRegister);
logoutButton.addEventListener("click", handleLogout);
restoreSession();
