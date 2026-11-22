/**
 * Local draft controller. Only a second, explicit submit sends a creation request.
 * The area is drafted for the page-wide user in `#user-select`; the review step
 * shows that user, and a draft reviewed for one user is never saved for another.
 */
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
  const error = root.getElementById('form-error');
  const placement = root.getElementById('draw-placement');
  const coordinates = root.getElementById('draw-coordinates');
  const userSelect = root.getElementById('user-select');
  let isReviewing = false;
  let isSaving = false;
  let reviewed = null;
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
  function open() {
    form.hidden = false;
    root.getElementById('draw-start').hidden = true;
    error.textContent = '';
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
    submit.textContent = 'Confirm and create';
    error.textContent = '';
    updatePreview();
  }
  function close() {
    settle(false);
    edit();
    form.reset();
    form.hidden = true;
    root.getElementById('draw-start').hidden = false;
    error.textContent = '';
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
        error.textContent = 'Place and size a circle on the map, or choose Enter coordinates.';
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
    submit.textContent = 'Creating…';
    for (const control of form.querySelectorAll('button')) control.disabled = true;
    try {
      const response = await request('/areas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(reviewed),
      });
      if (response.status !== 201) {
        const detail = response.status === 422 ? await response.json().catch(() => ({})) : {};
        throw new Error(
          detail.error ||
            (response.status === 422
              ? 'Check the area values and try again.'
              : 'Could not create area. Your draft has been kept.'),
        );
      }
      settle(true);
      close();
      saved();
    } catch (failure) {
      edit();
      error.textContent = failure.message || 'Could not create area. Your draft has been kept.';
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
    /** Throws the draft away, as Cancel does. */
    discard() {
      if (!form.hidden) close();
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
  };
}
