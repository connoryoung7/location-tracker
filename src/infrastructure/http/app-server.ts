import express from 'express';
import escapeHtml from 'escape-html';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildAreaEventView,
  type AreaEventListRow,
  type AreaEventView,
} from '@/application/build-area-event-view.ts';
import {
  buildAreaListView,
  type AreaCategoryRow,
  type AreaListRow,
  type AreaListView,
} from '@/application/build-area-list-view.ts';
import {
  buildAreaMapView,
  type AreaColorKey,
  type AreaMapView,
} from '@/application/build-area-map-view.ts';
import {
  buildVisitedPlaceView,
  type VisitedPlaceRow,
  type VisitedPlaceView,
} from '@/application/build-visited-place-view.ts';
import type { VisitedPlace } from '@/application/infer-visited-places.ts';
import { pickAreaCategoryColor } from '@/application/pick-area-category-color.ts';
import {
  CreateAreaCategorySchema,
  CreateCategorizedAreaSchema,
  SetAreaCategorySchema,
  UpdateAreaCategorySchema,
  UpdateAreaSchema,
} from '@/domain/schemas.ts';
import {
  AREA_CATEGORY_COLORS,
  type Area,
  type AreaCategory,
  type AreaCategoryColor,
} from '@/domain/types.ts';
import type {
  AreaCategoryRepository,
  AreaEventRepository,
  AreaRepository,
  Logger,
  MetricsCollector,
  TrackedUserRepository,
} from '@/domain/ports.ts';

/**
 * The map UI manages areas and triggers event-history recomputation, so it deliberately does not reuse the
 * ingestion app's `Deps` (location repository, decryptor, geofence evaluator,
 * event publisher).
 */
export interface AppDeps {
  users: TrackedUserRepository;
  recompute?: (userId: string) => Promise<{ locations: number; before: number; after: number }>;
  /** Works out where a user stopped within `range` (Unix epoch seconds). */
  visitedPlaces?: (userId: string, range: { from?: number }) => Promise<VisitedPlace[]>;
  areaRepo: AreaRepository;
  areaCategories: AreaCategoryRepository;
  areaEvents: AreaEventRepository;
  logger: Logger;
  metrics: MetricsCollector;
}

/** How often the browser re-fetches the areas fragment. */
const REFRESH_INTERVAL = '30s';

const VENDOR_PACKAGES = {
  maplibre: 'maplibre-gl/dist/maplibre-gl.mjs',
  htmx: 'htmx.org/dist/htmx.min.js',
  pico: '@picocss/pico',
} as const;

/**
 * Serializes JSON for embedding in a `<script>` block. Escaping `<` is what stops
 * an area named `</script><script>…` from breaking out of the element. This is a
 * JSON string escape, not HTML sanitization — the value stays byte-identical once
 * `JSON.parse` runs in the browser.
 */
function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * One line naming each invalid field and what is wrong with it, joined with `; `.
 * An issue about the whole input (e.g. "change the name or the colour") has no field.
 */
function describeIssues(issues: { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
}

/** Same limit as `CreateAreaSchema`, so every route accepts the same IDs. */
const MAX_USER_ID_LENGTH = 64;

type UserIdParam = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'valid'; userId: string };

/**
 * Reads the page-wide user from a query string or body. Blank means no user is
 * selected yet, which fragments answer with a prompt rather than an error.
 */
function parseUserId(value: unknown): UserIdParam {
  if (typeof value !== 'string' || !value.trim()) return { kind: 'missing' };
  if (value.length > MAX_USER_ID_LENGTH) return { kind: 'invalid' };
  return { kind: 'valid', userId: value };
}

/**
 * The areas data the map reads, tagged with whose areas they are. It also
 * carries the user's categories, which the New area form offers.
 */
type AreasPanelData = AreaMapView & {
  userId: string;
  categories: Pick<AreaCategory, 'id' | 'name' | 'color'>[];
};

function renderAreasData(data: AreasPanelData): string {
  return `<script type="application/json" id="areas-data">${escapeJsonForScript(data)}</script>`;
}

/** How each palette key is named in the colour pickers. */
const COLOR_LABELS: Record<AreaCategoryColor, string> = {
  blue: 'Blue',
  orange: 'Orange',
  aqua: 'Aqua',
};

/** A category's colour beside its name. The page's stylesheet turns the key into a shade. */
function renderSwatch(colorKey: AreaColorKey): string {
  return `<span class="category-swatch" data-color="${colorKey}" aria-hidden="true"></span>`;
}

function renderAreaItems(rows: AreaListRow[]): string {
  return rows
    .map(
      (row) => `
      <li>
        <button type="button" class="area-locate" data-bounds="${escapeHtml(JSON.stringify(row.bounds))}">
          <span class="area-name">${escapeHtml(row.name)}</span>
          <span class="area-radius">${Math.round(row.radius)} m</span>
        </button>
      </li>`,
    )
    .join('');
}

function renderAreasFragment(userId: string, areas: Area[], categories: AreaCategory[]): string {
  const data = renderAreasData({
    userId,
    ...buildAreaMapView(areas, categories),
    categories: categories.map(({ id, name, color }) => ({ id, name, color })),
  });
  const view = buildAreaListView(areas, categories);
  if (view.rows.length === 0) {
    return `
    <p class="legend-empty">No areas for ${escapeHtml(userId)} yet. Use <strong>Add area</strong> to draw one.</p>
    ${data}
  `;
  }

  const count = `<p class="area-count">${view.rows.length} ${view.rows.length === 1 ? 'area' : 'areas'}</p>`;
  // Without any categories there is nothing to group by: keep the plain list.
  if (categories.length === 0) {
    return `
    ${count}
    <ul class="area-names">${renderAreaItems(view.rows)}</ul>
    ${data}
  `;
  }

  const groups = view.groups
    .map(
      (group) => `
      <section class="area-group">
        <h3 class="area-group-heading">
          ${renderSwatch(group.category?.color ?? 'none')}
          <span class="area-group-name">${group.category ? escapeHtml(group.category.name) : 'Uncategorised'}</span>
          <span class="area-group-count">${group.rows.length}</span>
        </h3>
        <ul class="area-names">${renderAreaItems(group.rows)}</ul>
      </section>`,
    )
    .join('');

  return `
    ${count}
    ${groups}
    ${data}
  `;
}

/**
 * Shown until a user is selected. Carries an empty data block so the map drops
 * the previous user's circles instead of leaving them behind.
 */
function renderAreasPrompt(): string {
  return `
    <p class="legend-empty">Select a user above to see their areas.</p>
    ${renderAreasData({ userId: '', ...buildAreaMapView([]), categories: [] })}
  `;
}

/** A user ID no route will accept. Carries no data block, so the map is left as it was. */
function renderUserError(): string {
  return '<p class="notice legend-error" data-tone="error" role="alert">Unknown user.</p>';
}

/**
 * Shown in place of the legend when the areas cannot be read. Deliberately
 * carries no `areas-data` block, so the map keeps whatever it last rendered
 * rather than blanking out.
 */
function renderAreasError(): string {
  return `<p class="notice legend-error" data-tone="error" role="alert">Could not reach the area store. Retrying…</p>`;
}

function formatCoordinate(value: number): string {
  return value.toFixed(5);
}

function renderColorOptions(selected: AreaCategoryColor): string {
  return AREA_CATEGORY_COLORS.map(
    (color) =>
      `<option value="${color}"${color === selected ? ' selected' : ''}>${COLOR_LABELS[color]}</option>`,
  ).join('');
}

/** The Category cell of one area: changing it saves straight away. */
function renderAreaCategorySelect(row: AreaListRow, categories: AreaCategoryRow[]): string {
  const options = categories
    .map(
      (category) =>
        `<option value="${escapeHtml(category.id)}"${category.id === row.categoryId ? ' selected' : ''}>${escapeHtml(category.name)}</option>`,
    )
    .join('');
  return `
            <span class="area-list-category">
              ${renderSwatch(row.colorKey)}
              <select
                class="area-category-select"
                name="categoryId"
                aria-label="${escapeHtml(`Category for ${row.name}`)}"
                hx-patch="/areas/${encodeURIComponent(row.userId)}/${encodeURIComponent(row.areaId)}"
                hx-trigger="change"
                hx-target="#area-list"
                hx-swap="innerHTML"
              ><option value=""${row.categoryId === null ? ' selected' : ''}>None</option>${options}</select>
            </span>`;
}

/** Rename, recolour, delete, and add the user's categories. */
function renderCategoryManager(
  userId: string,
  categories: AreaCategoryRow[],
  error?: string,
): string {
  const rows = categories
    .map((category) => {
      const path = `/categories/${encodeURIComponent(userId)}/${encodeURIComponent(category.id)}`;
      const consequence =
        category.areaCount === 0
          ? 'It has no areas.'
          : `${category.areaCount} ${category.areaCount === 1 ? 'area' : 'areas'} will become uncategorised.`;
      return `
        <li class="category-row">
          <form class="category-edit" hx-patch="${path}" hx-target="#area-list" hx-swap="innerHTML">
            ${renderSwatch(category.color)}
            <input type="text" name="name" value="${escapeHtml(category.name)}" required maxlength="100" aria-label="${escapeHtml(`Name of ${category.name}`)}" />
            <select name="color" aria-label="${escapeHtml(`Colour of ${category.name}`)}">${renderColorOptions(category.color)}</select>
            <button type="submit" class="secondary outline">Save</button>
          </form>
          <button
            type="button"
            class="category-delete outline"
            hx-delete="${path}"
            hx-target="#area-list"
            hx-swap="innerHTML"
            hx-confirm="${escapeHtml(`Delete "${category.name}"? ${consequence}`)}"
          >Delete</button>
        </li>`;
    })
    .join('');

  return `
    <section class="category-manager" aria-labelledby="category-manager-heading">
      <h4 id="category-manager-heading">Categories</h4>
      ${error ? `<p class="notice" data-tone="error" role="alert">${escapeHtml(error)}</p>` : ''}
      ${categories.length === 0 ? '<p class="legend-empty">No categories yet.</p>' : `<ul class="category-list">${rows}</ul>`}
      <form class="category-add" hx-post="/categories" hx-target="#area-list" hx-swap="innerHTML">
        <input type="hidden" name="userId" value="${escapeHtml(userId)}" />
        <input type="text" name="name" required maxlength="100" placeholder="New category" aria-label="New category name" />
        <button type="submit" class="secondary">Add category</button>
      </form>
    </section>`;
}

function renderAreaListFragment(
  userId: string,
  view: AreaListView,
  options: { categoryError?: string } = {},
): string {
  const manager = renderCategoryManager(userId, view.categories, options.categoryError);
  if (view.rows.length === 0) {
    return `<p class="legend-empty">No areas for ${escapeHtml(userId)} yet.</p>${manager}`;
  }

  const rows = view.rows
    .map(
      (row) => `
        <tr>
          <th scope="row" class="area-list-name">${escapeHtml(row.name)}</th>
          <td>${renderAreaCategorySelect(row, view.categories)}</td>
          <td class="area-list-number">${formatCoordinate(row.lat)}, ${formatCoordinate(row.lon)}</td>
          <td class="area-list-number">${Math.round(row.radius)} m</td>
          <td class="area-list-actions">
            <button type="button" class="area-list-show secondary outline" data-bounds="${escapeHtml(JSON.stringify(row.bounds))}">Show</button>
            <button
              type="button"
              class="area-list-edit secondary outline"
              data-user-id="${escapeHtml(row.userId)}"
              data-area-id="${escapeHtml(row.areaId)}"
              data-name="${escapeHtml(row.name)}"
              data-lat="${row.lat}"
              data-lon="${row.lon}"
              data-radius="${row.radius}"
            >Edit</button>
            <button
              type="button"
              class="area-list-delete outline"
              hx-delete="/areas/${encodeURIComponent(row.userId)}/${encodeURIComponent(row.areaId)}"
              hx-target="#areas"
              hx-swap="innerHTML"
              hx-confirm="${escapeHtml(`Delete "${row.name}"?`)}"
            >Delete</button>
          </td>
        </tr>`,
    )
    .join('');

  return `
    <p class="area-list-count">${view.rows.length} ${view.rows.length === 1 ? 'area' : 'areas'}</p>
    <table class="area-list">
      <thead>
        <tr><th scope="col">Name</th><th scope="col">Category</th><th scope="col">Centre</th><th scope="col">Radius</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${manager}
  `;
}

/** How many of the selected user's most recent events the panel shows. */
const EVENT_LIST_LIMIT = 100;

function renderEventRow(row: AreaEventListRow): string {
  return `
            <li class="event-row event-${row.kind}">
              <button type="button" class="event-locate" data-lon="${row.lon}" data-lat="${row.lat}">
                <span class="event-kind">${row.kind === 'entered' ? 'Entered' : 'Exited'}</span>
                <span class="event-area">${escapeHtml(row.areaLabel)}</span>
                <time datetime="${row.isoTime}">${escapeHtml(row.timeLabel)}</time>
              </button>
            </li>`;
}

function renderEventsFragment(view: AreaEventView): string {
  const days = view.days
    .map((day) => {
      const count = `${day.rows.length} ${day.rows.length === 1 ? 'event' : 'events'}`;
      return `
      <li class="event-day">
        <h3 class="event-day-heading">
          <time datetime="${day.dateKey}">${escapeHtml(day.label)}</time>
          <span class="event-day-count">${count}</span>
        </h3>
        <ol class="event-list">${day.rows.map(renderEventRow).join('')}
        </ol>
      </li>`;
    })
    .join('');

  const emptyState =
    view.rows.length === 0 ? '<p class="events-empty">No events for this user yet.</p>' : '';

  return `
    ${emptyState}
    <ol class="event-days">${days}</ol>
    <script type="application/json" id="events-data">${escapeJsonForScript(view)}</script>
  `;
}

/**
 * Shown before a user is chosen. Carries an empty `events-data` block so the map
 * drops the previous user's points instead of leaving them behind.
 */
function renderEventsPrompt(): string {
  return `
    <p class="events-empty">Select a user above to see their events.</p>
    <script type="application/json" id="events-data">null</script>
  `;
}

/**
 * Like the areas error, it carries no `events-data` block, so the map keeps the
 * points it last rendered until the next poll succeeds.
 */
function renderEventsError(): string {
  return `<p class="notice legend-error" data-tone="error" role="alert">Could not load events. Retrying…</p>`;
}

/** The periods the places form offers, in days; `all` reads the whole history. */
const PLACE_PERIOD_DAYS: Record<string, number | undefined> = {
  '7': 7,
  '30': 30,
  '90': 90,
  all: undefined,
};

/** How many kinds of place the summary line names. */
const PLACE_CATEGORY_LIMIT = 4;

/**
 * Asks whether a place that is not yet an area should become one. The button
 * only opens a pre-filled draft in the New area form; nothing is saved until
 * the user confirms it there. The draft itself comes from the row's
 * `proposedArea` in the `places-data` block, which the map popup reads too.
 */
function renderAreaProposal(row: VisitedPlaceRow): string {
  if (!row.proposedArea) return '';
  return `
        <p class="place-propose">Make this a saved area?
          <button type="button" class="place-save-area outline" data-place-id="${escapeHtml(row.placeId)}">Save as area</button>
        </p>`;
}

function renderPlaceRow(row: VisitedPlaceRow): string {
  const detail = [row.category ?? row.note, row.durationLabel].filter(Boolean).join(' · ');
  const alternatives =
    row.alternatives.length === 0
      ? ''
      : `
        <details class="place-alternatives">
          <summary>Or nearby: ${row.alternatives.length} more</summary>
          <ul>${row.alternatives
            .map(
              (alternative) =>
                `<li>${escapeHtml(alternative.name)} <span>${escapeHtml(alternative.category)} · ${alternative.distanceMeters} m</span></li>`,
            )
            .join('')}</ul>
        </details>`;

  return `
      <li class="place-row place-${row.lookup}">
        <button type="button" class="place-locate" data-lon="${row.lon}" data-lat="${row.lat}">
          <span class="place-label">${escapeHtml(row.label)}</span>
          <span class="place-visits">${row.visitCount} ${row.visitCount === 1 ? 'visit' : 'visits'}</span>
          <span class="place-detail">${escapeHtml(detail)}</span>
          <span class="place-last">Last <time datetime="${row.lastVisitIso}">${row.lastVisitIso}</time></span>
        </button>${alternatives}${renderAreaProposal(row)}
      </li>`;
}

function renderPlacesFragment(view: VisitedPlaceView): string {
  const data = `<script type="application/json" id="places-data">${escapeJsonForScript(view)}</script>`;
  if (view.rows.length === 0) {
    return `<p class="events-empty">No stops of 5 minutes or more in this period.</p>${data}`;
  }

  const categories = view.categories
    .slice(0, PLACE_CATEGORY_LIMIT)
    .map(
      (category) =>
        `<li>${escapeHtml(category.category)} <strong>${category.visitCount}</strong></li>`,
    )
    .join('');
  const summary = categories
    ? `<ul class="place-categories" aria-label="Visits by kind of place">${categories}</ul>`
    : '';
  // OpenStreetMap data is ODbL-licensed and must be credited wherever it is shown.
  const usesOpenStreetMap = view.rows.some((row) => row.lookup === 'found');
  const attribution = usesOpenStreetMap
    ? '<p class="place-attribution">Nearest named place first, from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>. Each name is a best guess.</p>'
    : '';

  return `
    ${summary}
    <ol class="place-list">${view.rows.map(renderPlaceRow).join('')}</ol>
    ${attribution}
    ${data}
  `;
}

/**
 * Like the events error, it carries no `places-data` block, so the map keeps
 * the places it last showed.
 */
function renderPlacesNotice(message: string): string {
  return `<p class="notice legend-error" data-tone="error" role="alert">${escapeHtml(message)}</p>`;
}

/**
 * Out-of-band element carrying the draw form's error text. Sent alongside the
 * legend so a rejected area reports itself without blanking the sidebar; empty
 * on success, which also clears a previous error.
 */
function renderFormErrorOob(message: string): string {
  return `<p id="form-error" hx-swap-oob="true" class="notice" data-tone="error" role="status">${escapeHtml(message)}</p>`;
}

/**
 * @param selectedUserId From `?user=`. Rendered as the select's chosen option so
 *   the very first fragment loads already carry it, before `/users` answers.
 */
function renderPage(selectedUserId?: string): string {
  // htmx leaves disabled fields out of requests, so a preselected user keeps the
  // select enabled; with none, it waits disabled until the user poll fills it.
  const userSelect = selectedUserId
    ? `<select id="user-select" name="userId"><option value="${escapeHtml(selectedUserId)}" selected>${escapeHtml(selectedUserId)}</option></select>`
    : '<select id="user-select" name="userId" disabled><option value="">Loading users…</option></select>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <!--
      htmx does not swap 4xx/5xx responses by default, which would hide the
      areas-unavailable message and form validation errors. Opt 422 and 503 in
      specifically; the rest of the defaults are repeated verbatim because this
      replaces the whole array.
    -->
    <meta
      name="htmx-config"
      content='{"responseHandling":[{"code":"204","swap":false},{"code":"422","swap":true},{"code":"503","swap":true},{"code":"[23]..","swap":true},{"code":"[45]..","swap":false,"error":true}]}'
    />
    <title>Location Tracker — Areas</title>
    <link rel="stylesheet" href="/vendor/pico/pico.conditional.min.css" />
    <link rel="stylesheet" href="/vendor/maplibre/maplibre-gl.css" />
    <link rel="stylesheet" href="/static/app.css" />
    <script src="/vendor/htmx/htmx.min.js" defer></script>
    <script type="module" src="/static/app.js"></script>
  </head>
  <body>
    <aside id="sidebar" class="pico">
      <header class="app-header">
        <svg class="app-logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7Zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z" />
        </svg>
        <div>
          <h1>Location Tracker</h1>
          <p>Areas and geofence events</p>
        </div>
        <!--
          The one user the whole page shows. Every panel includes this form instead
          of keeping a selection of its own, and reloads when it changes.
        -->
        <form id="user-scope" class="user-scope">
          <!-- Set by app.js to the browser's zone, so events are grouped into the viewer's days. -->
          <input type="hidden" name="tz" id="user-scope-tz" />
          <label for="user-select">User</label>
          ${userSelect}
        </form>
        <p id="user-status" class="notice user-status" data-tone="info" role="status"></p>
      </header>

      <section class="panel" aria-labelledby="areas-heading">
        <div class="panel-header">
          <h2 id="areas-heading">Areas</h2>
          <button type="button" id="area-list-open" class="secondary outline" data-user-submit disabled>List areas</button>
        </div>
        <div
          id="areas"
          hx-get="/fragments/areas"
          hx-include="#user-scope"
          hx-trigger="load, change from:#user-scope, refresh, every ${REFRESH_INTERVAL}"
          hx-sync="this:replace"
          hx-swap="innerHTML"
        ></div>
      </section>

      <!--
        The draw panel sits outside #areas on purpose: the poll replaces that
        element every ${REFRESH_INTERVAL}, which would discard half-typed input.
      -->
      <section class="panel" id="draw-panel" aria-labelledby="draw-heading">
        <!-- The heading and review note switch to "Edit area" wording while an existing area is open. -->
        <h2 id="draw-heading">New area</h2>
        <button type="button" id="draw-start" class="block" disabled>Add area</button>
        <form id="draw-form" hidden>
          <ol class="draw-steps" aria-label="Progress">
            <li class="draw-step-edit">Place &amp; adjust</li>
            <li class="draw-step-review">Review</li>
          </ol>
          <fieldset id="draw-fields">
            <label>Place circle
              <select id="draw-placement">
                <option value="map" selected>On the map</option>
                <option value="coordinates">Enter coordinates</option>
              </select>
            </label>
            <p class="draw-hint" id="draw-placement-hint">Click the map to place the centre, move to size the circle, then click again.</p>
            <label>Name <input type="text" name="name" required maxlength="200" /></label>
            <!-- Filled by app.js from the user's categories in the areas fragment.
                 Hidden while editing: an area's category is changed in List areas. -->
            <label id="draw-category-label">Category
              <select name="categoryId" id="draw-category">
                <option value="" selected>None</option>
                <option value="__new__">New category…</option>
              </select>
            </label>
            <label id="draw-category-name-label" hidden>New category name <input type="text" name="categoryName" id="draw-category-name" maxlength="100" /></label>
            <p class="draw-readout" id="draw-readout">No centre set</p>
            <details id="draw-coordinates">
              <summary>Adjust coordinates and radius</summary>
              <label>Latitude <input type="number" name="lat" required min="-90" max="90" step="any" /></label>
              <label>Longitude <input type="number" name="lon" required min="-180" max="180" step="any" /></label>
              <label>Radius (metres) <input type="number" name="radius" required min="0.01" max="100000" step="any" /></label>
            </details>
          </fieldset>
          <section id="draw-confirmation" class="draw-review" hidden aria-label="Confirm area">
            <h3>Review area</h3>
            <p id="draw-review-note">The circle is a draft. Confirm and create adds it to your saved areas.</p>
            <p id="draw-summary"></p>
            <button type="button" id="draw-back" class="secondary outline">Back to editing</button>
          </section>
          <div class="draw-actions">
            <button type="submit" id="draw-submit" data-user-submit disabled>Review area</button>
            <button type="button" id="draw-cancel" class="secondary outline">Cancel</button>
          </div>
        </form>
        <p id="form-error" class="notice" data-tone="error" role="status"></p>
      </section>

      <section class="panel" id="events-panel" aria-labelledby="events-heading">
        <h2 id="events-heading">Recent events</h2>
        <!-- Refreshed when the user changes, after a recompute, and on the same poll as the areas. -->
        <div
          id="events"
          hx-get="/fragments/events"
          hx-include="#user-scope"
          hx-trigger="load, change from:#user-scope, refresh, every ${REFRESH_INTERVAL}"
          hx-sync="this:replace"
          hx-swap="innerHTML"
        ></div>
      </section>

      <section class="panel" aria-labelledby="recompute-heading">
        <h2 id="recompute-heading">Event history</h2>
        <p class="panel-hint">Rebuild this user's entry and exit events from their stored locations and their current areas.</p>
        <form id="recompute-form" class="recompute-form" hx-post="/users/recompute" hx-include="#user-scope" hx-target="#recompute-result" hx-confirm="Replace this user's event history using their current areas?" hx-disabled-elt="find button">
          <button type="submit" class="secondary" data-user-submit disabled>Recompute events</button>
          <span class="htmx-indicator" aria-busy="true">Recomputing…</span>
        </form>
        <p id="recompute-result" class="notice" data-tone="info" role="status"></p>
      </section>

      <!-- Loaded only on request: each run reads the whole period and may look places up online. -->
      <section class="panel" id="places-panel" aria-labelledby="places-heading">
        <h2 id="places-heading">Places visited</h2>
        <p class="panel-hint">Find where this user stopped for 5 minutes or more, and what was there.</p>
        <form id="places-form" class="places-form" hx-get="/fragments/places" hx-include="#user-scope" hx-target="#places" hx-swap="innerHTML" hx-disabled-elt="find button">
          <label>Period
            <select name="days">
              <option value="7">Last 7 days</option>
              <option value="30" selected>Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="all">All time</option>
            </select>
          </label>
          <button type="submit" class="secondary" data-user-submit disabled>Find places</button>
          <span class="htmx-indicator" aria-busy="true">Finding places…</span>
        </form>
        <div id="places"></div>
      </section>

      <!-- Loaded each time it opens, so it never shows a stale copy of the poll. -->
      <dialog id="area-list-dialog" aria-labelledby="area-list-title">
        <article>
          <header>
            <button type="button" id="area-list-close" aria-label="Close" rel="prev"></button>
            <h3 id="area-list-title">Areas</h3>
          </header>
          <div id="area-list" hx-get="/fragments/area-list" hx-include="#user-scope" hx-trigger="refresh" hx-sync="this:replace" hx-swap="innerHTML"></div>
        </article>
      </dialog>

      <dialog id="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-message">
        <article>
          <header><h3 id="confirm-title">Please confirm</h3></header>
          <p id="confirm-message"></p>
          <footer>
            <button type="button" id="confirm-cancel" class="secondary outline">Cancel</button>
            <button type="button" id="confirm-accept">Confirm</button>
          </footer>
        </article>
      </dialog>
    </aside>
    <main id="map" aria-label="Map of areas"></main>
  </body>
</html>`;
}

/** Whether the caller asked for JSON rather than a page fragment. */
function wantsJson(req: express.Request): boolean {
  return req.get('accept') === 'application/json';
}

function nameTakenMessage(name: string): string {
  return `There's already a category called "${name}".`;
}

export function createAppServer(deps: AppDeps) {
  const app = express();

  // The draw form posts urlencoded; JSON is accepted so the routes stay usable
  // from curl and scripts.
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      deps.logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
      deps.metrics.recordRequest(req.method, req.path, res.statusCode, duration);
    });
    next();
  });

  // MapLibre resolves its shared chunk and web worker relative to its own module
  // URL, so the whole dist directory has to be reachable, not just the entry file.
  for (const [route, entry] of Object.entries(VENDOR_PACKAGES)) {
    app.use(`/vendor/${route}`, express.static(dirname(Bun.resolveSync(entry, import.meta.dir))));
  }
  app.use('/static', express.static(new URL('../../../public', import.meta.url).pathname));

  app.get('/_metrics', async (_req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(await deps.metrics.getMetricsText());
  });

  app.get('/_health', async (_req, res) => {
    try {
      await deps.areaRepo.healthCheck();
      res.status(200).json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'error' });
    }
  });

  app.get('/', (req, res) => {
    // An over-long `?user=` is ignored rather than rejected: the page still
    // loads, and the user is picked as if none had been named.
    const user = parseUserId(req.query.user);
    res.type('html').send(renderPage(user.kind === 'valid' ? user.userId : undefined));
  });

  app.get('/fragments/areas', async (req, res) => {
    const user = parseUserId(req.query.userId);
    if (user.kind === 'missing') {
      res.type('html').send(renderAreasPrompt());
      return;
    }
    if (user.kind === 'invalid') {
      res.status(422).type('html').send(renderUserError());
      return;
    }
    await sendAreasFragment(res, user.userId);
  });

  app.get('/fragments/area-list', async (req, res) => {
    const user = parseUserId(req.query.userId);
    if (user.kind === 'missing') {
      res.type('html').send('<p class="legend-empty">Select a user above to see their areas.</p>');
      return;
    }
    if (user.kind === 'invalid') {
      res.status(422).type('html').send(renderUserError());
      return;
    }
    await sendAreaListFragment(res, user.userId);
  });

  app.get('/categories', async (req, res) => {
    const user = parseUserId(req.query.userId);
    if (user.kind !== 'valid') {
      res.status(422).json({ error: 'Select a user.' });
      return;
    }
    try {
      res.json(await deps.areaCategories.listCategories(user.userId));
    } catch (error) {
      deps.logger.error('Failed to load categories', error);
      res.status(503).json({ error: 'Could not load categories. Please retry.' });
    }
  });

  app.post('/categories', async (req, res) => {
    const result = CreateAreaCategorySchema.safeParse(req.body);
    const user = parseUserId(req.body?.userId);
    if (!result.success) {
      await sendCategoryRejection(req, res, user, 422, describeIssues(result.error.issues));
      return;
    }

    const { userId, name } = result.data;
    try {
      const color =
        result.data.color ??
        pickAreaCategoryColor(await deps.areaCategories.listCategories(userId));
      const id = randomUUID();
      const outcome = await deps.areaCategories.addCategory({ id, userId, name, color });
      if (outcome === 'name-taken') {
        await sendCategoryRejection(req, res, user, 409, nameTakenMessage(name));
        return;
      }
      if (wantsJson(req)) {
        res.status(201).json({ id, color });
        return;
      }
      await sendAreaListFragment(res, userId);
    } catch (error) {
      deps.logger.error('Failed to create category', error);
      sendStoreFailure(req, res);
    }
  });

  app.patch('/categories/:userId/:categoryId', async (req, res) => {
    const user = parseUserId(req.params.userId);
    const result = UpdateAreaCategorySchema.safeParse(req.body ?? {});
    if (user.kind !== 'valid' || !result.success) {
      const message = result.success ? 'Unknown user.' : describeIssues(result.error.issues);
      await sendCategoryRejection(req, res, user, 422, message);
      return;
    }

    try {
      const outcome = await deps.areaCategories.updateCategory(
        user.userId,
        req.params.categoryId,
        result.data,
      );
      if (outcome === 'not-found') {
        await sendCategoryRejection(req, res, user, 404, 'That category no longer exists.');
        return;
      }
      if (outcome === 'name-taken') {
        await sendCategoryRejection(req, res, user, 409, nameTakenMessage(result.data.name!));
        return;
      }
      if (wantsJson(req)) {
        res.json(await deps.areaCategories.getCategory(user.userId, req.params.categoryId));
        return;
      }
      await sendAreaListFragment(res, user.userId);
    } catch (error) {
      deps.logger.error('Failed to update category', error);
      sendStoreFailure(req, res);
    }
  });

  app.delete('/categories/:userId/:categoryId', async (req, res) => {
    const user = parseUserId(req.params.userId);
    if (user.kind !== 'valid') {
      await sendCategoryRejection(req, res, user, 422, 'Unknown user.');
      return;
    }

    try {
      const isRemoved = await deps.areaCategories.removeCategory(
        user.userId,
        req.params.categoryId,
      );
      if (wantsJson(req)) {
        res.status(isRemoved ? 204 : 404).end();
        return;
      }
      // Deleting one that is already gone needs no error: the list shows it's gone.
      await sendAreaListFragment(res, user.userId);
    } catch (error) {
      deps.logger.error('Failed to delete category', error);
      sendStoreFailure(req, res);
    }
  });

  app.patch('/areas/:userId/:areaId', async (req, res) => {
    const user = parseUserId(req.params.userId);
    const result = SetAreaCategorySchema.safeParse(req.body ?? {});
    if (user.kind !== 'valid' || !result.success) {
      const message = result.success ? 'Unknown user.' : describeIssues(result.error.issues);
      await sendCategoryRejection(req, res, user, 422, message);
      return;
    }

    const { categoryId } = result.data;
    try {
      // An area can only be in one of its own user's categories; the database
      // can't enforce that, so it's checked here.
      if (categoryId && !(await deps.areaCategories.getCategory(user.userId, categoryId))) {
        await sendCategoryRejection(req, res, user, 422, "Choose one of this user's categories.");
        return;
      }
      if (!(await deps.areaRepo.setAreaCategory(user.userId, req.params.areaId, categoryId))) {
        await sendCategoryRejection(req, res, user, 404, 'That area no longer exists.');
        return;
      }
      if (wantsJson(req)) {
        res.json({ areaId: req.params.areaId, categoryId });
        return;
      }
      await sendAreaListFragment(res, user.userId);
    } catch (error) {
      deps.logger.error("Failed to change an area's category", error);
      sendStoreFailure(req, res);
    }
  });

  app.get('/fragments/events', async (req, res) => {
    const user = parseUserId(req.query.userId);
    if (user.kind === 'missing') {
      res.type('html').send(renderEventsPrompt());
      return;
    }
    if (user.kind === 'invalid') {
      res.status(422).type('html').send(renderUserError());
      return;
    }

    const { userId } = user;
    try {
      const [events, areas] = await Promise.all([
        deps.areaEvents.listAreaEvents(userId, { limit: EVENT_LIST_LIMIT }),
        // Only for naming events after their areas' current names. Without them
        // the events still show, under the names they were stored with.
        deps.areaRepo.listAreas(userId).catch((error: unknown) => {
          deps.logger.warn('Failed to load areas for naming events; using stored names', error);
          return undefined;
        }),
      ]);
      const timeZone = typeof req.query.tz === 'string' ? req.query.tz : undefined;
      res
        .type('html')
        .send(renderEventsFragment(buildAreaEventView(userId, events, { timeZone, areas })));
    } catch (error) {
      deps.logger.error('Failed to load events', error);
      res.status(503).type('html').send(renderEventsError());
    }
  });

  app.get('/users', async (_req, res) => {
    try {
      res.json(await deps.users.listUserIds());
    } catch (error) {
      deps.logger.error('Failed to load users', error);
      res.status(503).json({ error: 'Could not load users. Retrying…' });
    }
  });

  app.post('/users/recompute', async (req, res) => {
    const user = parseUserId(req.body?.userId);
    if (user.kind !== 'valid') {
      res.status(422).send('Select a user above.');
      return;
    }
    const { userId } = user;
    try {
      if (!deps.recompute) throw new Error('Recompute is unavailable');
      const result = await deps.recompute(userId);
      res
        .type('html')
        .send(
          `Processed ${result.locations} locations. Events: ${result.before} before, ${result.after} after.`,
        );
    } catch (error) {
      deps.logger.error('Recompute failed', error);
      res.status(503).send('Could not recompute events. Please retry.');
    }
  });

  app.get('/fragments/places', async (req, res) => {
    const user = parseUserId(req.query.userId);
    if (user.kind !== 'valid') {
      res.status(422).type('html').send(renderPlacesNotice('Select a user above.'));
      return;
    }
    const { userId } = user;
    const period = typeof req.query.days === 'string' ? req.query.days : '30';
    if (!Object.hasOwn(PLACE_PERIOD_DAYS, period)) {
      res.status(422).type('html').send(renderPlacesNotice('Choose a period from the list.'));
      return;
    }

    const days = PLACE_PERIOD_DAYS[period];
    const range = days === undefined ? {} : { from: Math.floor(Date.now() / 1000) - days * 86_400 };
    try {
      if (!deps.visitedPlaces) throw new Error('Visited places are unavailable');
      const places = await deps.visitedPlaces(userId, range);
      res.type('html').send(renderPlacesFragment(buildVisitedPlaceView(userId, places)));
    } catch (error) {
      deps.logger.error('Failed to find visited places', error);
      res.status(503).type('html').send(renderPlacesNotice('Could not find places. Please retry.'));
    }
  });

  app.post('/areas', async (req, res) => {
    const rejectArea = async (message: string) => {
      if (wantsJson(req)) {
        res.status(422).json({ error: message });
        return;
      }
      const user = parseUserId(req.body?.userId);
      if (user.kind === 'valid') {
        await sendAreasFragment(res, user.userId, { status: 422, formError: message });
      } else {
        res
          .status(422)
          .type('html')
          .send(renderAreasPrompt() + renderFormErrorOob(message));
      }
    };

    const result = CreateCategorizedAreaSchema.safeParse(req.body);
    if (!result.success) {
      await rejectArea(describeIssues(result.error.issues));
      return;
    }

    const { userId, name, lat, lon, radius, categoryId, categoryName } = result.data;
    const id = randomUUID();
    try {
      const category = await resolveCategory(userId, { categoryId, categoryName });
      if (category === 'not-found') {
        await rejectArea("Choose one of this user's categories.");
        return;
      }
      // The server owns the ID so a client cannot overwrite an existing area by
      // posting a known one.
      await deps.areaRepo.addArea({
        id,
        userId,
        name,
        lat,
        lon,
        radius,
        ...(category ? { categoryId: category.id } : {}),
      });
    } catch (error) {
      deps.logger.error('Failed to create area', error);
      res.status(503).type('html').send(renderAreasError());
      return;
    }

    if (wantsJson(req)) {
      res.status(201).json({ id });
      return;
    }

    // Respond with the refreshed areas so the sidebar and map update together.
    await sendAreasFragment(res, userId);
  });

  // Changes an area's name and circle in place. JSON only: the area form is its one caller.
  app.put('/areas/:userId/:areaId', async (req, res) => {
    const result = UpdateAreaSchema.safeParse(req.body);
    if (!result.success) {
      res.status(422).json({ error: describeIssues(result.error.issues) });
      return;
    }

    const { userId, areaId } = req.params;
    let isUpdated: boolean;
    try {
      // One write scoped by ID and owner: an edit can never create an area, reach
      // another user's, or bring back one deleted meanwhile. The geofence index
      // keeps who is inside the area, so the next location fires only real changes.
      isUpdated = await deps.areaRepo.updateArea({ id: areaId, userId, ...result.data });
    } catch (error) {
      deps.logger.error('Failed to update area', error);
      res.status(503).json({ error: 'Could not save changes. Your edits have been kept.' });
      return;
    }

    if (!isUpdated) {
      res.status(404).json({ error: 'This area no longer exists.' });
      return;
    }
    res.json({ id: areaId });
  });

  /**
   * The category a new area goes in: an existing one of the user's by ID, or one
   * named by the user, reused if they already have it (ignoring case) and
   * created if not. `undefined` when the area is uncategorised.
   */
  async function resolveCategory(
    userId: string,
    { categoryId, categoryName }: { categoryId?: string; categoryName?: string },
  ): Promise<AreaCategory | undefined | 'not-found'> {
    if (categoryId) {
      return (await deps.areaCategories.getCategory(userId, categoryId)) ?? 'not-found';
    }
    if (!categoryName) return undefined;

    const existing = await deps.areaCategories.findCategoryByName(userId, categoryName);
    if (existing) return existing;
    const category: AreaCategory = {
      id: randomUUID(),
      userId,
      name: categoryName,
      color: pickAreaCategoryColor(await deps.areaCategories.listCategories(userId)),
    };
    // Lost a race to an identical name: use the one that won.
    if ((await deps.areaCategories.addCategory(category)) === 'name-taken') {
      return (await deps.areaCategories.findCategoryByName(userId, categoryName)) ?? 'not-found';
    }
    return category;
  }

  /** The areas list and Categories section, for the modal. */
  async function sendAreaListFragment(
    res: express.Response,
    userId: string,
    options: { status?: number; categoryError?: string } = {},
  ): Promise<void> {
    try {
      const [areas, categories] = await Promise.all([
        deps.areaRepo.listAreas(userId),
        deps.areaCategories.listCategories(userId),
      ]);
      res
        .status(options.status ?? 200)
        .type('html')
        .send(renderAreaListFragment(userId, buildAreaListView(areas, categories), options));
    } catch (error) {
      deps.logger.error('Failed to load the area list', error);
      res.status(503).type('html').send(renderAreasError());
    }
  }

  /**
   * A category change that can't be made. JSON callers get the conventional
   * status; the page gets 422 (the only client error its htmx config swaps in)
   * with the list re-rendered and the reason in the Categories section.
   */
  async function sendCategoryRejection(
    req: express.Request,
    res: express.Response,
    user: UserIdParam,
    status: number,
    message: string,
  ): Promise<void> {
    if (wantsJson(req) || user.kind !== 'valid') {
      res.status(status).json({ error: message });
      return;
    }
    await sendAreaListFragment(res, user.userId, { status: 422, categoryError: message });
  }

  function sendStoreFailure(req: express.Request, res: express.Response): void {
    if (wantsJson(req)) {
      res.status(503).json({ error: 'Could not reach the area store. Please retry.' });
      return;
    }
    res.status(503).type('html').send(renderAreasError());
  }

  app.delete('/areas/:userId/:areaId', async (req, res) => {
    try {
      await deps.areaRepo.removeArea(req.params.userId, req.params.areaId);
    } catch (error) {
      deps.logger.error('Failed to delete area', error);
      res.status(503).type('html').send(renderAreasError());
      return;
    }

    await sendAreasFragment(res, req.params.userId);
  });

  /** The areas panel for one user: their area names plus the circles for the map. */
  async function sendAreasFragment(
    res: express.Response,
    userId: string,
    options: { status?: number; formError?: string } = {},
  ): Promise<void> {
    try {
      const [areas, categories] = await Promise.all([
        deps.areaRepo.listAreas(userId),
        deps.areaCategories.listCategories(userId),
      ]);
      res
        .status(options.status ?? 200)
        .type('html')
        .send(
          renderAreasFragment(userId, areas, categories) +
            renderFormErrorOob(options.formError ?? ''),
        );
    } catch (error) {
      // The page polls this endpoint, so an outage would otherwise leave a blank
      // sidebar with the reason buried in the server log. Degrade to a visible
      // message and let the next poll recover on its own.
      deps.logger.error('Failed to load areas', error);
      res.status(503).type('html').send(renderAreasError());
    }
  }

  return app;
}
