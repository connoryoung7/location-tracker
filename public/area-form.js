/**
 * Local draft controller. Only a second, explicit submit sends a creation request.
 * The area is drafted for the page-wide user in `#user-select`; the review step
 * shows that user, and a draft reviewed for one user is never saved for another.
 *
 * The same draft edits an existing area: `editArea` opens it pre-filled, and the
 * confirmed draft replaces that area's name and circle instead of adding one.
 */

const COPY = {
  create: {
    heading: 'New area',
    reviewNote: 'The circle is a draft. Confirm and create adds it to your saved areas.',
    confirm: 'Confirm and create',
    saving: 'Creating…',
    failed: 'Could not create area. Your draft has been kept.',
  },
  edit: {
    heading: 'Edit area',
    reviewNote: 'Save changes replaces the name and circle of this area.',
    confirm: 'Save changes',
    saving: 'Saving…',
    failed: 'Could not save changes. Your edits have been kept.',
  },
};

export function createAreaForm(
  root,
  {
    preview,
    started,
    cancelled,
    saved,
    placementChanged = (_mode) => {},
    editingChanged = (_isEditable) => {},
    request = (url, options) => fetch(url, options),
  },
) {
  const form = root.getElementById('draw-form');
  const fields = root.getElementById('draw-fields');
  const confirmation = root.getElementById('draw-confirmation');
  const submit = root.getElementById('draw-submit');
  /**
   * Looked up on every use: the areas fragment swaps a fresh #form-error in out of
   * band on every load, so a reference kept from start-up would be a detached copy.
   */
  const setError = (message) => {
    root.getElementById('form-error').textContent = message;
  };
  const placement = root.getElementById('draw-placement');
  const coordinates = root.getElementById('draw-coordinates');
  const userSelect = root.getElementById('user-select');
  let isReviewing = false;
  let isSaving = false;
  let reviewed = null;
  /** The area being edited, or null while drafting a new one. */
  let editingAreaId = null;
  const copy = () => (editingAreaId ? COPY.edit : COPY.create);
  /** Resolves the promise `propose` returned: true once saved, false once abandoned. */
  let settleProposal = null;
  function settle(isSaved) {
    settleProposal?.(isSaved);
    settleProposal = null;
  }
  const values = () => ({
    userId: userSelect.value,
    ...Object.fromEntries(
      ['name', 'lat', 'lon', 'radius'].map((key) => [key, form.elements.namedItem(key).value]),
    ),
  });
  function edit() {
    isReviewing = false;
    reviewed = null;
    confirmation.hidden = true;
    fields.hidden = false;
    submit.textContent = 'Review area';
    editingChanged(true);
  }
  function updatePreview() {
    const data = values();
    const lat = Number(data.lat),
      lon = Number(data.lon),
      radius = Number(data.radius);
    const valid =
      data.lat !== '' &&
      data.lon !== '' &&
      data.radius !== '' &&
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Number.isFinite(radius) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180 &&
      radius > 0 &&
      radius <= 100000;
    preview(valid ? [lon, lat] : null, valid ? radius : 0);
  }
  function open(areaId = null) {
    editingAreaId = areaId;
    root.getElementById('draw-heading').textContent = copy().heading;
    root.getElementById('draw-review-note').textContent = copy().reviewNote;
    form.hidden = false;
    root.getElementById('draw-start').hidden = true;
    setError('');
    edit();
  }
  function review(data) {
    reviewed = data;
    root.getElementById('draw-summary').textContent =
      `${data.name} — User: ${data.userId}; Latitude: ${data.lat}; Longitude: ${data.lon}; Radius: ${data.radius} metres.`;
    isReviewing = true;
    editingChanged(false);
    fields.hidden = true;
    confirmation.hidden = false;
    submit.textContent = copy().confirm;
    setError('');
    updatePreview();
  }
  function close() {
    settle(false);
    edit();
    form.reset();
    editingAreaId = null;
    root.getElementById('draw-heading').textContent = COPY.create.heading;
    form.hidden = true;
    root.getElementById('draw-start').hidden = false;
    setError('');
    preview(null, 0);
    cancelled();
  }
  root.getElementById('draw-start').addEventListener('click', () => {
    open();
    placement.value = 'map';
    coordinates.open = false;
    root.getElementById('draw-placement-hint').textContent =
      'Click the map to place the centre, move to size the circle, then click again.';
    started();
  });
  placement.addEventListener('change', () => {
    if (isSaving) return;
    edit();
    coordinates.open = placement.value === 'coordinates';
    root.getElementById('draw-placement-hint').textContent =
      placement.value === 'map'
        ? 'Click the map to place the centre, move to size the circle, then click again.'
        : 'Enter latitude, longitude, and radius below. The map previews your changes.';
    placementChanged(placement.value);
  });
  root.getElementById('draw-cancel').addEventListener('click', () => {
    if (!isSaving) close();
  });
  root.getElementById('draw-back').addEventListener('click', () => {
    if (!isSaving) edit();
  });
  form.addEventListener('input', (event) => {
    if (!isSaving) {
      edit();
      if (event.target === form || ['lat', 'lon', 'radius'].includes(event.target.name)) {
        updatePreview();
      }
    }
  });
  form.addEventListener('change', () => {
    if (!isSaving) edit();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (isSaving) return;
    const data = values();
    // Native validity remains active because the fields are hidden, not disabled.
    if (!form.checkValidity() || !data.userId) {
      edit();
      if (placement.value === 'map' && (!data.lat || !data.lon || !data.radius)) {
        setError('Place and size a circle on the map, or choose Enter coordinates.');
        return;
      }
      coordinates.open = true;
      form.reportValidity();
      return;
    }
    if (!isReviewing || JSON.stringify(data) !== JSON.stringify(reviewed)) {
      review(data);
      return;
    }
    isSaving = true;
    submit.textContent = copy().saving;
    for (const control of form.querySelectorAll('button')) control.disabled = true;
    const { failed } = copy();
    try {
      const { userId, ...changes } = reviewed;
      // The owner is fixed for an edit, so it travels in the URL, not the body.
      const [url, method, body, expected] = editingAreaId
        ? [
            `/areas/${encodeURIComponent(userId)}/${encodeURIComponent(editingAreaId)}`,
            'PUT',
            changes,
            200,
          ]
        : ['/areas', 'POST', reviewed, 201];
      const response = await request(url, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status !== expected) {
        // 422 names the bad field; 404 means the area was deleted meanwhile.
        const hasDetail = response.status === 422 || response.status === 404;
        const detail = hasDetail ? await response.json().catch(() => ({})) : {};
        throw new Error(
          detail.error ||
            (response.status === 422 ? 'Check the area values and try again.' : failed),
        );
      }
      settle(true);
      close();
      saved();
    } catch (failure) {
      edit();
      setError(failure.message || failed);
    } finally {
      isSaving = false;
      for (const control of form.querySelectorAll('button')) control.disabled = false;
      submit.disabled = !userSelect.value;
    }
  });
  return {
    /** Whether a draft is in progress, from Add area until it is saved or cancelled. */
    isOpen() {
      return !form.hidden;
    },
    /** Whether a confirmed area is being created right now. */
    isSaving() {
      return isSaving;
    },
    /**
     * Throws the draft away, as Cancel does. Refused while saving: the request is
     * already on its way, and its completion closes the form itself.
     */
    discard() {
      if (!isSaving && !form.hidden) close();
    },
    setGeometry(centre, radius) {
      if (isSaving || isReviewing) return;
      form.elements.namedItem('lat').value = String(centre[1]);
      form.elements.namedItem('lon').value = String(centre[0]);
      form.elements.namedItem('radius').value = String(
        Math.max(0.01, Math.round(radius * 100) / 100),
      );
      updatePreview();
    },
    /**
     * Opens a pre-filled draft, e.g. for a place the user keeps visiting, at the
     * review step when it is complete and at the name field when it has none.
     * Nothing is saved until the user confirms, as with a drawn area. The promise
     * resolves true once the area is created, or false if the draft is cancelled,
     * replaced by another proposal, or discarded by a user switch.
     */
    propose({ userId, name, lat, lon, radius }) {
      // The area is drafted for the page-wide user, so a place found for anyone
      // else is refused. Places are cleared whenever the user changes, so this
      // only guards against a stale button.
      if (isSaving || !userId || userId !== userSelect.value) return Promise.resolve(false);
      settle(false);
      open();
      placement.value = 'coordinates';
      coordinates.open = true;
      root.getElementById('draw-placement-hint').textContent =
        'Centred on the place visited. Adjust the name or circle if needed, then choose Review area.';
      for (const [key, value] of Object.entries({ name, lat, lon, radius })) {
        form.elements.namedItem(key).value = String(value);
      }
      placementChanged('coordinates');
      updatePreview();
      // An unnamed place needs a name first.
      const nameField = form.elements.namedItem('name');
      if (!nameField.value) {
        nameField.focus();
      } else if (form.checkValidity()) {
        review(values());
        submit.focus();
      }
      return new Promise((resolve) => {
        settleProposal = resolve;
      });
    },
    /**
     * Opens an existing area pre-filled, at the edit step with its circle on the
     * map, replacing any draft in progress. Saving replaces its name and circle;
     * Cancel leaves it as it was. Returns false, opening nothing, while another
     * area is being saved or when the area is not the page-wide user's.
     */
    editArea({ userId, areaId, name, lat, lon, radius }) {
      if (isSaving || !areaId || !userId || userId !== userSelect.value) return false;
      settle(false);
      open(areaId);
      placement.value = 'coordinates';
      coordinates.open = true;
      root.getElementById('draw-placement-hint').textContent =
        'Drag the centre marker or edit the coordinates and radius. Choose Review area when ready.';
      for (const [key, value] of Object.entries({ name, lat, lon, radius })) {
        form.elements.namedItem(key).value = String(value);
      }
      placementChanged('coordinates');
      updatePreview();
      form.elements.namedItem('name').focus();
      return true;
    },
  };
}
