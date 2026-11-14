/** Keep the draft's draggable centre and numeric geometry in sync. */
export function createDraftMarker(map, Marker, moved) {
  let marker = null;
  let radius = 0;
  let isEditable = true;
  return {
    update(centre, nextRadius) {
      radius = nextRadius;
      if (!centre) {
        marker?.remove();
        marker = null;
        return;
      }
      if (!marker) {
        marker = new Marker({ draggable: isEditable, color: '#2563eb' });
        const element = marker.getElement();
        element.title = 'Drag to move the centre of this draft area';
        element.setAttribute('aria-label', element.title);
        // A marker click must not be treated as a second map-placement click.
        element.addEventListener('click', (event) => event.stopPropagation());
        marker.on('drag', () => {
          if (!isEditable) return;
          const { lng, lat } = marker.getLngLat();
          const longitude = ((((lng + 180) % 360) + 360) % 360) - 180;
          // A centre dragged before sizing starts with an editable 100m radius.
          moved([longitude, lat], radius > 0 ? radius : 100);
        });
        marker.setLngLat(centre).addTo(map);
      } else {
        marker.setLngLat(centre);
      }
    },
    setEditable(value) {
      isEditable = value;
      marker?.setDraggable(value);
    },
  };
}
