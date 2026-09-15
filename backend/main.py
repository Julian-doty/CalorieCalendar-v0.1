import datetime as dt
import logging
import math
import os
import re
import secrets
import sqlite3
from collections.abc import Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

import httpx
from fastapi import Body, Depends, FastAPI, Form, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.security.utils import get_authorization_scheme_param
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

# Log through uvicorn's logger so messages show up in the server console.
logger = logging.getLogger("uvicorn.error")

# Browser origins allowed to call the API: a comma-separated list in this environment variable, such as
# "https://calorie-calendar.netlify.app". Without it, only the local frontend dev server may call the API;
# browsers treat localhost and 127.0.0.1 as different origins, so the default lists both.
ALLOWED_ORIGINS_ENV_VAR = "ALLOWED_ORIGINS"
DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5500", "http://127.0.0.1:5500"]
# A scheme and host (with an optional port) and nothing after it, which is what browsers send as the Origin.
ORIGIN_PATTERN = re.compile(r"https?://[^/\s]+")


def load_allowed_origins() -> list[str]:
    configured = os.environ.get(ALLOWED_ORIGINS_ENV_VAR, "").strip()
    if not configured:
        return DEFAULT_ALLOWED_ORIGINS
    origins = []
    for entry in configured.split(","):
        # Origins never end in a slash, so a copied "https://example.com/" would otherwise never match.
        origin = entry.strip().rstrip("/")
        if ORIGIN_PATTERN.fullmatch(origin):
            origins.append(origin)
        elif origin:
            logger.warning(
                "Ignoring %r in %s: use just a scheme and host, like https://calorie-calendar.netlify.app",
                origin,
                ALLOWED_ORIGINS_ENV_VAR,
            )
    if origins:
        logger.info("Accepting browser requests from %s", ", ".join(origins))
    else:
        logger.warning("%s has no valid origins, so browsers can't call the API", ALLOWED_ORIGINS_ENV_VAR)
    return origins


ALLOWED_ORIGINS = load_allowed_origins()

# Open Food Facts' full-text search service (Search-a-licious). The
# world.openfoodfacts.org /api/v2 and /api/v4 search endpoints ignore free-text
# search terms, so they can't look foods up by name.
OPEN_FOOD_FACTS_SEARCH_URL = "https://search.openfoodfacts.org/search"
OPEN_FOOD_FACTS_FIELDS = "code,product_name,nutriments,image_front_url,image_url"
SEARCH_PAGE_SIZE = 10
KJ_PER_KCAL = 4.184

# Open Food Facts asks API clients to send a custom User-Agent with contact details. A logged-in user's
# searches name that user's email (from their login token); other searches fall back to the email in this
# environment variable, which keeps it out of the code and may be left empty.
APP_USER_AGENT = "CalorieCalendar/0.1"
CONTACT_EMAIL_ENV_VAR = "OPEN_FOOD_FACTS_CONTACT_EMAIL"

# Characters the search service parses as query syntax; "peanut butter: crunchy"
# would otherwise become a field query that matches nothing.
QUERY_SYNTAX_PATTERN = re.compile(r'([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)')

# Entries added through the API live in a SQLite file next to this module. The frontend's
# IndexedDB list is separate: a server can't read or write a browser's IndexedDB.
# Set CALORIE_CALENDAR_DATABASE to use another file (e.g. a throwaway one for tests).
DEFAULT_ENTRIES_DATABASE_PATH = Path(__file__).with_name("calorieCalendar.db")
ENTRIES_DATABASE_ENV_VAR = "CALORIE_CALENDAR_DATABASE"
ENTRIES_SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    food TEXT NOT NULL,
    calories INTEGER NOT NULL CHECK (calories >= 0),
    date TEXT NOT NULL,        -- YYYY-MM-DD
    created_at TEXT NOT NULL   -- ISO 8601 in UTC, e.g. 2026-09-14T08:30:00.000Z
);
CREATE INDEX IF NOT EXISTS entries_date ON entries (date);
"""


def build_user_agent(contact_email: str | None) -> str:
    return f"{APP_USER_AGENT} ({contact_email})" if contact_email else APP_USER_AGENT


@asynccontextmanager
async def lifespan(app: FastAPI):
    fallback_email = os.environ.get(CONTACT_EMAIL_ENV_VAR, "").strip()
    if not fallback_email:
        logger.info("%s is not set; food searches without a login token won't include a contact email", CONTACT_EMAIL_ENV_VAR)
    # The client's default User-Agent is the fallback; search_food swaps in a logged-in user's email.
    async with httpx.AsyncClient(
        headers={"User-Agent": build_user_agent(fallback_email)},
        timeout=httpx.Timeout(10.0, connect=5.0),
    ) as client:
        app.state.http_client = client
        yield


app = FastAPI(title="Calorie Calendar", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    # Authorization carries the login token to protected routes.
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
def health():
    return {"status": "healthy"}


@app.get("/")
def read_root():
    return {"message": "Calorie Calendar Backend is running!"}

def get_http_client(request: Request) -> httpx.AsyncClient:
    return request.app.state.http_client


class CamelModel(BaseModel):
    """snake_case in Python, camelCase in JSON to match the frontend."""

    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True)


class SearchFoodRequest(CamelModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    food_name: str = Field(min_length=1, max_length=100, examples=["banana"])


class Macronutrients(CamelModel):
    protein: float | None = Field(description="Grams per 100 g")
    fat: float | None = Field(description="Grams per 100 g")
    carbs: float | None = Field(description="Grams per 100 g")


class FoodProduct(CamelModel):
    barcode: str | None
    product_name: str
    # Explicit aliases: to_camel would capitalize the letter after the digits ("Per100G").
    calories_per_100g: float | None = Field(alias="caloriesPer100g", description="kcal per 100 g")
    macronutrients_per_100g: Macronutrients = Field(alias="macronutrientsPer100g")
    image_url: str | None


class SearchFoodResponse(CamelModel):
    food_name: str
    products: list[FoodProduct]


def to_number(value: Any) -> float | None:
    """Nutriment values can be numbers, numeric strings, or missing."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        number = float(value)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def get_calories_per_100g(nutriments: dict[str, Any]) -> float | None:
    kcal = to_number(nutriments.get("energy-kcal_100g"))
    if kcal is not None:
        return kcal
    # Some products only list energy in kJ ("energy_100g" is always kJ).
    kj = to_number(nutriments.get("energy-kj_100g"))
    if kj is None:
        kj = to_number(nutriments.get("energy_100g"))
    return round(kj / KJ_PER_KCAL, 1) if kj is not None else None


def parse_product(hit: Any) -> FoodProduct | None:
    if not isinstance(hit, dict):
        return None
    name = hit.get("product_name")
    if not isinstance(name, str) or not name.strip():
        return None

    nutriments = hit.get("nutriments")
    if not isinstance(nutriments, dict):
        nutriments = {}
    barcode = hit.get("code")
    image_url = hit.get("image_front_url") or hit.get("image_url")

    return FoodProduct(
        barcode=barcode if isinstance(barcode, str) else None,
        product_name=name.strip(),
        calories_per_100g=get_calories_per_100g(nutriments),
        macronutrients_per_100g=Macronutrients(
            protein=to_number(nutriments.get("proteins_100g")),
            fat=to_number(nutriments.get("fat_100g")),
            carbs=to_number(nutriments.get("carbohydrates_100g")),
        ),
        image_url=image_url if isinstance(image_url, str) else None,
    )


@app.post("/search-food")
async def search_food(
    search_request: SearchFoodRequest,
    request: Request,
    http_client: Annotated[httpx.AsyncClient, Depends(get_http_client)],
) -> SearchFoodResponse:
    """Search Open Food Facts by food name and return nutrition per 100 g.

    With a valid login token, the user's email is sent to Open Food Facts as the contact address.
    """
    params = {
        "q": QUERY_SYNTAX_PATTERN.sub(r"\\\1", search_request.food_name),
        "page_size": SEARCH_PAGE_SIZE,
        "fields": OPEN_FOOD_FACTS_FIELDS,
    }
    # Set by the read_token_email middleware (below) from the Authorization header.
    token_email = request.state.token_email
    user_agent = build_user_agent(token_email) if token_email else http_client.headers["User-Agent"]
    logger.debug("Open Food Facts User-Agent for this search: %r", user_agent)

    try:
        response = await http_client.get(OPEN_FOOD_FACTS_SEARCH_URL, params=params, headers={"User-Agent": user_agent})
        response.raise_for_status()
        payload = response.json()
    except httpx.TimeoutException as exc:
        logger.warning("Open Food Facts search timed out: %r", exc)
        raise HTTPException(status_code=504, detail="Open Food Facts did not respond in time.") from exc
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        logger.warning("Open Food Facts search returned HTTP %s", status)
        if status in (429, 503):
            raise HTTPException(status_code=503, detail="Open Food Facts is busy. Try again shortly.") from exc
        raise HTTPException(status_code=502, detail=f"Open Food Facts returned an error (HTTP {status}).") from exc
    except httpx.RequestError as exc:
        logger.warning("Could not reach Open Food Facts: %r", exc)
        raise HTTPException(status_code=502, detail="Could not reach Open Food Facts.") from exc
    # ValueError covers bad JSON syntax and encoding; RecursionError covers absurdly deep nesting.
    except (ValueError, RecursionError) as exc:
        logger.warning("Open Food Facts returned a non-JSON response")
        raise HTTPException(status_code=502, detail="Open Food Facts returned an invalid response.") from exc

    hits = payload.get("hits") if isinstance(payload, dict) else None
    if not isinstance(hits, list):
        logger.warning("Open Food Facts response has no 'hits' list")
        raise HTTPException(status_code=502, detail="Open Food Facts returned an unexpected response.")
    if payload.get("timed_out"):
        logger.warning("Open Food Facts search timed out upstream; results may be partial")

    products = [product for product in map(parse_product, hits) if product is not None]
    logger.info("Search for %r returned %d products", search_request.food_name, len(products))
    return SearchFoodResponse(food_name=search_request.food_name, products=products)


# --- Users and authentication (JWT) ---

# passlib's PBKDF2-SHA256 scheme: passlib's bcrypt support doesn't work with current bcrypt releases,
# and PBKDF2 needs no extra native package. 600,000 rounds follows current OWASP guidance.
PASSWORD_CONTEXT = CryptContext(schemes=["pbkdf2_sha256"], pbkdf2_sha256__default_rounds=600_000)
JWT_SECRET_ENV_VAR = "JWT_SECRET_KEY"
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60
USERNAME_PATTERN = r"^[A-Za-z0-9._-]+$"
# The HTML spec's check for type="email" inputs, but with a dot required in the domain. It only allows ASCII
# without spaces or parentheses, so the address can go straight into the Open Food Facts User-Agent header.
EMAIL_PATTERN = (
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+"
    r"@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$"
)
# Users live in the same SQLite file as the entries (CALORIE_CALENDAR_DATABASE overrides both).
USERS_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    hashed_password TEXT NOT NULL,
    created_at TEXT NOT NULL,  -- ISO 8601 in UTC
    email TEXT                 -- NULL only for accounts created before registration asked for one
);
"""

# Also gives Swagger UI (/docs) an "Authorize" button that logs in through /login.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")


def load_jwt_secret() -> str:
    secret = os.environ.get(JWT_SECRET_ENV_VAR, "").strip()
    if len(secret) >= 32:
        return secret
    logger.warning(
        "%s is missing or shorter than 32 characters; using a random key, so login tokens stop working when the server restarts",
        JWT_SECRET_ENV_VAR,
    )
    return secrets.token_urlsafe(32)


JWT_SECRET_KEY = load_jwt_secret()


class User(BaseModel):
    """A stored user. The hashed password never leaves the backend."""

    username: str
    hashed_password: str
    email: str | None  # None only for accounts created before registration asked for an email


class AccessToken(BaseModel):
    # Standard OAuth2 field names, which Swagger UI and OAuth2 clients expect, so no camelCase here.
    access_token: str
    token_type: str = "bearer"


def get_users_connection() -> Iterator[sqlite3.Connection]:
    database_path = os.environ.get(ENTRIES_DATABASE_ENV_VAR) or DEFAULT_ENTRIES_DATABASE_PATH
    connection = None
    try:
        # Same threadpool note as get_entries_connection below.
        connection = sqlite3.connect(database_path, check_same_thread=False)
        connection.executescript(USERS_SCHEMA)
        # A users table created before emails were collected lacks the column; its existing users get NULL.
        if "email" not in {column[1] for column in connection.execute("PRAGMA table_info(users)")}:
            connection.execute("ALTER TABLE users ADD COLUMN email TEXT")
            logger.info("Added the email column to the users table in %s", database_path)
    except sqlite3.Error as exc:
        if connection is not None:
            connection.close()
        logger.error("Could not open the users database at %s: %r", database_path, exc)
        raise HTTPException(status_code=500, detail="The users database is unavailable.") from exc
    try:
        yield connection
    finally:
        connection.close()


def find_user(connection: sqlite3.Connection, username: str) -> User | None:
    query = "SELECT username, hashed_password, email FROM users WHERE username = ?"
    row = connection.execute(query, (username,)).fetchone()
    return User(username=row[0], hashed_password=row[1], email=row[2]) if row else None


def create_access_token(user: User) -> str:
    now = dt.datetime.now(dt.timezone.utc)
    claims = {"sub": user.username, "iat": now, "exp": now + dt.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)}
    # Lets /search-food name the user as the Open Food Facts contact without a database lookup.
    if user.email:
        claims["email"] = user.email
    return jwt.encode(claims, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def get_current_user(
    token: Annotated[str, Depends(oauth2_scheme)],
    connection: Annotated[sqlite3.Connection, Depends(get_users_connection)],
) -> User:
    """Dependency for protected routes: a valid, unexpired token for a user that still exists."""
    invalid_token = HTTPException(status_code=401, detail="Invalid or expired token.", headers={"WWW-Authenticate": "Bearer"})
    try:
        claims = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except JWTError as exc:
        raise invalid_token from exc
    username = claims.get("sub")
    if not isinstance(username, str):
        raise invalid_token
    try:
        user = find_user(connection, username)
    except sqlite3.Error as exc:
        logger.error("Could not look up user %r: %r", username, exc)
        raise HTTPException(status_code=500, detail="The users database is unavailable.") from exc
    if user is None:
        raise invalid_token
    return user


@app.middleware("http")
async def read_token_email(request: Request, call_next):
    """Set request.state.token_email to the email in a valid Bearer token, or None.

    Never rejects a request: a missing, expired or forged token just means no email. It only checks the
    token's signature and expiry, so it's for choosing the Open Food Facts contact, not for access control;
    protected routes use get_current_user.
    """
    request.state.token_email = None
    scheme, token = get_authorization_scheme_param(request.headers.get("Authorization"))
    if scheme.lower() == "bearer" and token:
        try:
            email = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM]).get("email")
        except JWTError:
            email = None
        if isinstance(email, str):
            request.state.token_email = email
    return await call_next(request)


@app.post("/register", status_code=201)
def register(
    username: Annotated[str, Form(min_length=3, max_length=50, pattern=USERNAME_PATTERN)],
    password: Annotated[str, Form(min_length=6, max_length=128)],
    email: Annotated[str, Form(max_length=254, pattern=EMAIL_PATTERN)],
    connection: Annotated[sqlite3.Connection, Depends(get_users_connection)],
) -> dict[str, str]:
    """Create a user from form fields, e.g. curl -d "username=john&password=secret&email=john@example.com"."""
    hashed_password = PASSWORD_CONTEXT.hash(password)
    created_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    try:
        with connection:
            connection.execute(
                "INSERT INTO users (username, hashed_password, email, created_at) VALUES (?, ?, ?, ?)",
                (username, hashed_password, email, created_at),
            )
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="That username is already taken.") from exc
    except sqlite3.Error as exc:
        logger.error("Could not save user %r: %r", username, exc)
        raise HTTPException(status_code=500, detail="Couldn't create the user.") from exc
    logger.info("Registered user %r", username)
    return {"status": "user created", "username": username, "email": email}


@app.post("/login")
def login(
    credentials: Annotated[OAuth2PasswordRequestForm, Depends()],
    connection: Annotated[sqlite3.Connection, Depends(get_users_connection)],
) -> AccessToken:
    """Exchange a username and password (form fields) for a JWT access token."""
    wrong_credentials = HTTPException(
        status_code=401, detail="Incorrect username or password.", headers={"WWW-Authenticate": "Bearer"}
    )
    try:
        user = find_user(connection, credentials.username)
    except sqlite3.Error as exc:
        logger.error("Could not look up user %r: %r", credentials.username, exc)
        raise HTTPException(status_code=500, detail="The users database is unavailable.") from exc
    if user is None:
        # Take as long as a real password check, so response times don't reveal which usernames exist.
        PASSWORD_CONTEXT.dummy_verify()
        raise wrong_credentials
    if not PASSWORD_CONTEXT.verify(credentials.password, user.hashed_password):
        raise wrong_credentials
    logger.info("User %r logged in", user.username)
    return AccessToken(access_token=create_access_token(user))


@app.get("/me")
def read_current_user(current_user: Annotated[User, Depends(get_current_user)]) -> dict[str, str]:
    """Return the logged-in user's name; the frontend uses it to check that a stored token is still valid."""
    return {"username": current_user.username}


# --- Calorie entries (SQLite) ---


def get_entries_connection() -> Iterator[sqlite3.Connection]:
    database_path = os.environ.get(ENTRIES_DATABASE_ENV_VAR) or DEFAULT_ENTRIES_DATABASE_PATH
    connection = None
    try:
        # FastAPI may run this dependency and the endpoint on different threadpool threads;
        # the connection is still only used by one request.
        connection = sqlite3.connect(database_path, check_same_thread=False)
        connection.executescript(ENTRIES_SCHEMA)
    except sqlite3.Error as exc:
        if connection is not None:
            connection.close()
        logger.error("Could not open the entries database at %s: %r", database_path, exc)
        raise HTTPException(status_code=500, detail="The entries database is unavailable.") from exc
    try:
        yield connection
    finally:
        connection.close()


class EntryCreate(CamelModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    food: str = Field(min_length=1, max_length=200, examples=["apple"])
    # Strict: a JSON integer only, so "95", 95.5 and true are rejected rather than coerced.
    calories: int = Field(ge=0, le=100_000, strict=True, examples=[95])
    date: dt.date | None = Field(default=None, description="Day of the entry (YYYY-MM-DD); defaults to today")


class Entry(CamelModel):
    id: int
    food: str
    calories: int
    date: dt.date
    created_at: str = Field(description="When the entry was added (ISO 8601, UTC)")


# Adding entries requires a login token; listing them stays public.
@app.post("/add-entry", status_code=201, dependencies=[Depends(get_current_user)])
def add_entry(
    entry: Annotated[EntryCreate, Body()],
    connection: Annotated[sqlite3.Connection, Depends(get_entries_connection)],
) -> dict[str, str]:
    """Store a calorie entry in the backend database."""
    entry_date = entry.date or dt.date.today()
    created_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    try:
        with connection:
            connection.execute(
                "INSERT INTO entries (food, calories, date, created_at) VALUES (?, ?, ?, ?)",
                (entry.food, entry.calories, entry_date.isoformat(), created_at),
            )
    except sqlite3.Error as exc:
        logger.error("Could not save entry %r: %r", entry.food, exc)
        raise HTTPException(status_code=500, detail="Couldn't save the entry.") from exc
    logger.info("Added entry %r (%d kcal) for %s", entry.food, entry.calories, entry_date)
    return {"status": "entry added"}


@app.get("/get-entries")
def get_entries(
    response: Response,
    connection: Annotated[sqlite3.Connection, Depends(get_entries_connection)],
) -> list[Entry]:
    """Return every stored entry, newest date first (the same order as the frontend's table)."""
    try:
        rows = connection.execute(
            "SELECT id, food, calories, date, created_at FROM entries ORDER BY date DESC, created_at DESC, id DESC"
        ).fetchall()
    except sqlite3.Error as exc:
        logger.error("Could not read entries: %r", exc)
        raise HTTPException(status_code=500, detail="Couldn't read the entries.") from exc
    # The list changes with every add, so don't let a browser reuse an old copy.
    response.headers["Cache-Control"] = "no-store"
    return [
        Entry(id=entry_id, food=food, calories=calories, date=entry_date, created_at=created_at)
        for entry_id, food, calories, entry_date, created_at in rows
    ]
