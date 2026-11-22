/** Populate both user selectors without replacing the forms or their draft state. */
export function updateUserSelects(root, users) {
  for (const select of root.querySelectorAll('[data-user-select]')) {
    const previous = select.value;
    const options = [...new Set(users)].sort();
    select.replaceChildren();
    const placeholder = root.createElement('option');
    placeholder.value = '';
    placeholder.textContent = options.length ? 'Select a user' : 'No tracked users yet';
    select.append(placeholder);
    for (const user of options) {
      const option = root.createElement('option');
      option.value = user;
      option.textContent = user;
      select.append(option);
    }
    select.value = options.includes(previous) ? previous : options.length === 1 ? options[0] : '';
    // reset() should also select the sole user for the next area.
    for (const option of select.options) option.defaultSelected = option.value === select.value;
    select.disabled = options.length === 0;
    for (const button of select.form.querySelectorAll('[data-user-submit]'))
      button.disabled = options.length === 0;
    if (select.value !== previous)
      select.dispatchEvent(new root.defaultView.Event('change', { bubbles: true }));
  }
}

/** Local draft controller. Only a second, explicit submit sends a creation request. */
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
  let isReviewing = false;
  let isSaving = false;
  let reviewed = null;
  /** Resolves the promise `propose` returned: true once saved, false once abandoned. */
  let settleProposal = null;
  function settle(isSaved) {
    settleProposal?.(isSaved);
    settleProposal = null;
  }
  const values = () =>
    Object.fromEntries(
      ['userId', 'name', 'lat', 'lon', 'radius'].map((key) => [
        key,
        form.elements.namedItem(key).value,
      ]),
    );
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
      submit.disabled = form.elements.namedItem('userId').disabled;
    }
  });
  return {
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
     * review step when it is complete and at the first missing field otherwise.
     * Nothing is saved until the user confirms, as with a drawn area. The promise
     * resolves true once the area is created, or false if the draft is cancelled
     * or replaced by another proposal.
     */
    propose({ userId, name, lat, lon, radius }) {
      if (isSaving) return Promise.resolve(false);
      settle(false);
      open();
      placement.value = 'coordinates';
      coordinates.open = true;
      root.getElementById('draw-placement-hint').textContent =
        'Centred on the place visited. Adjust the name or circle if needed, then choose Review area.';
      for (const [key, value] of Object.entries({ userId, name, lat, lon, radius })) {
        form.elements.namedItem(key).value = String(value);
      }
      placementChanged('coordinates');
      updatePreview();
      // An unnamed place, or a user missing from the list, needs an answer first.
      const missing = ['name', 'userId']
        .map((key) => form.elements.namedItem(key))
        .find((field) => !field.value);
      if (missing) {
        missing.focus();
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
