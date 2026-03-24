(function () {
  const config = window.SpotmapConfig || {};
  const SUPABASE_URL = config.supabaseUrl;
  const SUPABASE_ANON_KEY = config.supabaseAnonKey;
  const supabaseReady = !!(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase);
  const client = supabaseReady ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

  const qs = (s, r = document) => r.querySelector(s);
  const qsa = (s, r = document) => [...r.querySelectorAll(s)];
  const params = new URLSearchParams(location.search);

  const state = {
    session: null,
    user: null,
    citySlug: document.body.dataset.city || params.get('city') || null,
    city: null,
    cities: [],
    projects: [],
    selectedProjectId: null,
    spots: [],
    projectSpotMap: new Map(),
    spotImageMap: new Map(),
    markerMap: new Map(),
    map: null,
    markersLayer: null,
    loading: false,
    activeSpotId: null,
    spotSearchTerm: '',
  };

  function toast(message) {
    const el = qs('#globalStatus');
    if (el) el.textContent = message;
  }

  function setSupabaseBadge() {
    const badge = qs('#supabaseBadge');
    if (!badge) return;
    badge.innerHTML = `<span class="status-dot ${supabaseReady ? 'online' : ''}"></span>${supabaseReady ? 'Supabase verbunden' : 'Supabase Config fehlt'}`;
  }

  function getCityCover(slug) {
    return (config.cityCovers && config.cityCovers[slug]) || config.defaultCityCover || '';
  }

  async function bootstrap() {
    setSupabaseBadge();
    if (document.body.dataset.page === 'home') {
      await loadCities();
      renderCityCards();
      return;
    }
    if (document.body.dataset.page === 'city') {
      await setupAuth();
      await loadCityPage();
      bindCityUi();
    }
  }

  async function setupAuth() {
    if (!client) return;
    const { data } = await client.auth.getSession();
    state.session = data.session || null;
    state.user = data.session?.user || null;
    renderAuthState();

    client.auth.onAuthStateChange(async (_event, session) => {
      state.session = session || null;
      state.user = session?.user || null;
      renderAuthState();
      await loadProjects();
      renderProjectList();
      renderPlanningPanel();
      renderLayerPanel();
      renderAreasPanel();
    });
  }

  function renderAuthState() {
    const email = qs('#authUserEmail');
    const guest = qs('#guestHint');
    const authOnly = qsa('[data-auth-only]');
    if (email) email.textContent = state.user?.email || 'Nicht eingeloggt';
    if (guest) guest.style.display = state.user ? 'none' : 'block';
    authOnly.forEach(el => el.disabled = !state.user);
    const favToggle = qs('#favoritesOnlyToggle');
    if (favToggle) favToggle.disabled = !state.selectedProjectId;
  }

  async function loadCities() {
    if (!client) {
      state.cities = [
        { city_id: 'prag', slug: 'prag', name: 'Prag', country: 'Tschechien', description_short: 'Die Ausgangsbasis der ganzen Nummer.' },
        { city_id: 'stuttgart', slug: 'stuttgart', name: 'Stuttgart', country: 'Deutschland', description_short: 'Home turf mit vielen testbaren Workflows.' },
        { city_id: 'innsbruck', slug: 'innsbruck', name: 'Innsbruck', country: 'Österreich', description_short: 'Berge, Spots und Tripplanung mit Aussicht.' }
      ];
      return;
    }

    const { data, error } = await client
      .from('cities')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (error) {
      console.error(error);
      toast('Fehler beim Laden der Städte.');
      state.cities = [];
      return;
    }
    state.cities = data || [];
  }

  function renderCityCards() {
    const grid = qs('#cityGrid');
    if (!grid) return;

    if (!state.cities.length) {
      grid.innerHTML = `<div class="empty-state">Noch keine Städte gefunden. Das ist noch keine Skatemap, das ist erst der Parkplatz davor.</div>`;
      return;
    }

    grid.innerHTML = state.cities.map(city => `
      <a class="card city-card" href="./${city.slug}/index.html">
        <div class="city-card-bg" style="background-image:url('${getCityCover(city.slug)}')"></div>
        <div class="meta"><span>${city.country || ''}</span><span>•</span><span>${city.slug}</span></div>
        <h3>${city.name}</h3>
        <p>${city.description_short || 'Stalinplaza und billiges Bier'}</p>
        <div class="row-wrap">
          <span class="pill">Map öffnen</span>
        </div>
      </a>
    `).join('');
  }

  async function loadCityPage() {
    if (!state.citySlug) {
      toast('Kein City-Slug gefunden.');
      return;
    }
    await loadCity();
    await Promise.all([loadSpots(), loadProjects(), loadSpotImages()]);
    initMap();
    renderSpotList();
    renderProjectList();
    renderPlanningPanel();
    renderLayerPanel();
    renderAreasPanel();
    initUiScaffolding();
  }

  async function loadCity() {
    if (!client) {
      state.city = { city_id: state.citySlug, slug: state.citySlug, name: titleCase(state.citySlug), country: '', default_lat: 50.0755, default_lng: 14.4378, default_zoom: 12 };
      applyCityUi();
      return;
    }

    const { data, error } = await client
      .from('cities')
      .select('*')
      .eq('slug', state.citySlug)
      .single();

    if (error) {
      console.error(error);
      toast('Stadt konnte nicht geladen werden.');
      return;
    }
    state.city = data;
    applyCityUi();
  }

  function applyCityUi() {
    const title = state.city?.name ? `${state.city.name} Skatemap` : 'Spotmap';
    document.title = title;
    const h1 = qs('#cityTitle');
    const sub = qs('#citySubtitle');
    const hero = qs('#heroBg');
    if (h1) h1.textContent = title;
    if (sub) sub.textContent = `Wähle ein Projekt oder erstelle ein neues. Ohne Projekt läuft die Map erstmal im Read-Only-Modus.`;
    if (hero) hero.style.backgroundImage = `url('${getCityCover(state.citySlug)}')`;
  }

  async function loadSpots() {
    if (!client || !state.city) {
      state.spots = [];
      return;
    }

    let query = client
      .from('spots')
      .select('*')
      .eq('city_id', state.city.city_id)
      .order('name', { ascending: true });

    // Wenn die Spalte existiert, wollen wir versteckte Spots nicht anzeigen.
    query = query.eq('is_hidden', false);

    const { data, error } = await query;

    if (error) {
      console.error(error);
      toast('Spots konnten nicht geladen werden.');
      state.spots = [];
      return;
    }
    state.spots = data || [];
  }

  async function loadProjects() {
    const wrapper = qs('#projectList');
    if (!wrapper) return;

    if (!client || !state.user || !state.city) {
      state.projects = [];
      state.selectedProjectId = null;
      state.projectSpotMap = new Map();
      renderProjectList();
      updateMarkers();
      renderSpotList();
      return;
    }

    const { data, error } = await client
      .from('projects')
      .select('*')
      .eq('city_id', state.city.city_id)
      .eq('owner_user_id', state.user.id)
      .eq('is_archived', false)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error(error);
      toast('Projekte konnten nicht geladen werden.');
      return;
    }

    const previous = state.selectedProjectId;
    state.projects = data || [];
    state.selectedProjectId = state.projects.some(project => project.id === previous)
      ? previous
      : (state.projects[0]?.id || null);

    await loadProjectSpots();
  }

  async function loadProjectSpots() {
    state.projectSpotMap = new Map();
    if (!client || !state.selectedProjectId) {
      updateMarkers();
      renderSpotList();
      renderPlanningPanel();
      renderLayerPanel();
      renderAreasPanel();
      renderAuthState();
      return;
    }

    const { data, error } = await client
      .from('project_spots')
      .select('*')
      .eq('project_id', state.selectedProjectId);

    if (error) {
      console.error(error);
      toast('Projekt-Spot-Zustände konnten nicht geladen werden.');
      updateMarkers();
      renderSpotList();
      renderPlanningPanel();
      renderLayerPanel();
      renderAreasPanel();
      renderAuthState();
      return;
    }

    (data || []).forEach(row => state.projectSpotMap.set(String(row.spot_id), row));
    updateMarkers();
    renderSpotList();
    renderPlanningPanel();
    renderLayerPanel();
    renderAreasPanel();
    renderAuthState();
  }

  async function loadSpotImages() {
    state.spotImageMap = new Map();
    if (!client || !state.citySlug) return;

    const folder = state.citySlug;
    const { data, error } = await client
      .storage
      .from('spot-images')
      .list(folder, {
        limit: 2000,
        offset: 0,
        sortBy: { column: 'name', order: 'asc' }
      });

    if (error) {
      console.warn('Spotbilder konnten nicht geladen werden:', error.message);
      return;
    }

    for (const file of data || []) {
      if (!file?.name || !/\.(jpg|jpeg|png|webp)$/i.test(file.name)) continue;
      const spotId = getSpotIdFromFilename(file.name);
      if (!spotId) continue;
      const path = `${folder}/${file.name}`;
      const { data: publicUrlData } = client.storage.from('spot-images').getPublicUrl(path);
      const current = state.spotImageMap.get(spotId) || [];
      current.push({
        name: file.name,
        path,
        url: publicUrlData.publicUrl,
        order: getImageNumber(file.name),
      });
      current.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      state.spotImageMap.set(spotId, current);
    }
  }

  function getSpotIdFromFilename(filename) {
    const match = String(filename).match(/^(\d+)_/);
    return match ? String(match[1]) : null;
  }

  function getImageNumber(filename) {
    const match = String(filename).match(/_(\d+)\.(jpg|jpeg|png|webp)$/i);
    return match ? Number(match[1]) : 999;
  }

  function getSpotImages(spot) {
    return state.spotImageMap.get(String(spot.spot_id)) || [];
  }

  function getSpotTitleImage(spot) {
    return getSpotImages(spot)[0]?.url || '';
  }

  function renderProjectList() {
    const wrapper = qs('#projectList');
    const current = qs('#currentProjectInfo');
    const manageBtn = qs('#editProjectBtn');
    if (!wrapper) return;

    if (!state.user) {
      wrapper.innerHTML = `<div class="empty-state">Login nötig, um Projekte zu sehen oder anzulegen.</div>`;
      if (current) current.textContent = 'Kein Projekt aktiv';
      if (manageBtn) manageBtn.disabled = true;
      return;
    }

    if (!state.projects.length) {
      wrapper.innerHTML = `<div class="empty-state">Noch kein Projekt in ${state.city?.name || 'dieser Stadt'}. Zeit für den ersten Kickflip in Tabellenform.</div>`;
      if (current) current.textContent = 'Kein Projekt aktiv';
      if (manageBtn) manageBtn.disabled = true;
      return;
    }

    wrapper.innerHTML = state.projects.map(project => `
      <div class="project-card ${project.id === state.selectedProjectId ? 'active' : ''}">
        <button class="project-item ${project.id === state.selectedProjectId ? 'active' : ''}" data-project-id="${project.id}">
          <h4>${escapeHtml(project.name)}</h4>
          <p>${escapeHtml(project.description || 'Ohne Beschreibung. Noch sehr geheimagentig.')}</p>
        </button>
        <div class="project-meta-row">
          <span class="muted">${project.is_public ? 'öffentlich' : 'privat'}</span>
          <span class="muted">${formatDate(project.updated_at)}</span>
        </div>
      </div>
    `).join('');

    qsa('[data-project-id]', wrapper).forEach(btn => {
      btn.addEventListener('click', async () => {
        state.selectedProjectId = btn.dataset.projectId;
        renderProjectList();
        await loadProjectSpots();
      });
    });

    const activeProject = state.projects.find(p => p.id === state.selectedProjectId);
    if (current) current.textContent = activeProject ? activeProject.name : 'Kein Projekt aktiv';
    if (manageBtn) manageBtn.disabled = !activeProject;
  }

  function spotEffectiveState(spot) {
    const row = state.projectSpotMap.get(String(spot.spot_id));
    return {
      row,
      existsInProject: !!row,
      layer: row?.layer ?? 1,
      comment: row?.comment ?? '',
      status: row?.status ?? 'none',
      visited: row?.visited ?? false,
      is_favorite: row?.is_favorite ?? false,
      priority: row?.priority ?? null,
      planned_day: row?.planned_day ?? row?.day ?? null,
      area: row?.area ?? spot.area ?? '',
    };
  }

  function getFilteredSpots() {
    const typeFilter = qs('#spotTypeFilter')?.value || '';
    const favoritesOnly = !!qs('#favoritesOnlyToggle')?.checked;
    const term = state.spotSearchTerm;

    return state.spots.filter(spot => {
      const eff = spotEffectiveState(spot);
      const haystack = [spot.name, spot.address, spot.description, spot.spot_type, eff.comment, eff.area]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const matchesSearch = !term || haystack.includes(term);
      const matchesType = !typeFilter || spot.spot_type === typeFilter;
      const matchesFavorite = !favoritesOnly || eff.is_favorite;
      return matchesSearch && matchesType && matchesFavorite;
    });
  }

  function renderSpotList(searchTerm = state.spotSearchTerm || '') {
    const wrapper = qs('#spotList');
    const count = qs('#spotCount');
    if (!wrapper) return;

    state.spotSearchTerm = String(searchTerm || '').trim().toLowerCase();
    const visibleSpots = getFilteredSpots();

    if (count) count.textContent = `${visibleSpots.length} Spots`;

    if (!visibleSpots.length) {
      wrapper.innerHTML = `<div class="empty-state">Noch keine Spots geladen. Vielleicht steht die DB noch mit Helm am Rand und macht sich warm.</div>`;
      return;
    }

    wrapper.innerHTML = visibleSpots.slice(0, 220).map(spot => {
      const eff = spotEffectiveState(spot);
      const image = getSpotTitleImage(spot);
      return `
        <div class="spot-card ${state.activeSpotId === String(spot.spot_id) ? 'active' : ''}" data-spot-card="${spot.spot_id}">
          <button class="spot-item spot-item-rich" data-spot-id="${spot.spot_id}">
            <div class="spot-item-thumb">${image ? `<img src="${image}" alt="${escapeHtml(spot.name)}" loading="lazy">` : `<div class="spot-thumb-fallback">📍</div>`}</div>
            <div class="spot-item-main">
              <div class="spot-item-topline">
                <h4>${escapeHtml(spot.name)}</h4>
                <span class="spot-badge">L${eff.layer}</span>
              </div>
              <p>${escapeHtml(spot.spot_type || 'spot')} · ${formatStatus(eff.status)}${eff.planned_day ? ` · Tag ${escapeHtml(eff.planned_day)}` : ''}</p>
              <div class="spot-flags">
                ${eff.is_favorite ? `<span class="mini-tag">★ Favorit</span>` : ''}
                ${eff.visited ? `<span class="mini-tag">✓ besucht</span>` : ''}
                ${eff.comment ? `<span class="mini-tag">Kommentar</span>` : ''}
              </div>
            </div>
          </button>
          <div class="spot-row-actions">
            <button class="ghost-btn compact-btn" type="button" data-open-spot="${spot.spot_id}">Info</button>
            <button class="ghost-btn compact-btn" type="button" data-edit-spot="${spot.spot_id}" ${(!state.user || !state.selectedProjectId) ? 'disabled' : ''}>Bearbeiten</button>
          </div>
        </div>
      `;
    }).join('');

    qsa('[data-spot-id]', wrapper).forEach(btn => {
      btn.addEventListener('click', () => {
        const spot = getSpotById(btn.dataset.spotId);
        focusSpotOnMap(spot, true);
      });
    });
    qsa('[data-open-spot]', wrapper).forEach(btn => {
      btn.addEventListener('click', () => {
        const spot = getSpotById(btn.dataset.openSpot);
        focusSpotOnMap(spot, true);
      });
    });
    qsa('[data-edit-spot]', wrapper).forEach(btn => {
      btn.addEventListener('click', () => {
        const spot = getSpotById(btn.dataset.editSpot);
        openSpotEditor(spot);
      });
    });
  }

  function initMap() {
    if (state.map || !window.L || !state.city) return;
    state.map = L.map('map', { zoomControl: true }).setView([state.city.default_lat, state.city.default_lng], state.city.default_zoom || 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap'
    }).addTo(state.map);
    state.markersLayer = L.layerGroup().addTo(state.map);
    updateMarkers();
  }

  function updateMarkers() {
    if (!state.map || !state.markersLayer) return;
    state.markersLayer.clearLayers();
    state.markerMap = new Map();

    getFilteredSpots().forEach(spot => {
      const eff = spotEffectiveState(spot);
      const marker = L.circleMarker([Number(spot.lat), Number(spot.lng)], {
        radius: Math.max(6, 5 + Number(eff.layer || 1)),
        weight: state.activeSpotId === String(spot.spot_id) ? 3 : 1,
        opacity: 1,
        fillOpacity: eff.existsInProject ? 0.88 : 0.65,
        color: layerColor(eff.layer),
        fillColor: layerColor(eff.layer)
      });

      marker.bindPopup(buildSpotPopupHtml(spot, eff), { maxWidth: 360 });
      marker.on('popupopen', () => bindPopupActions(spot));
      marker.on('click', () => setActiveSpot(spot.spot_id));
      state.markersLayer.addLayer(marker);
      state.markerMap.set(String(spot.spot_id), marker);
    });
  }

  function buildSpotPopupHtml(spot, eff = spotEffectiveState(spot)) {
    const titleImage = getSpotTitleImage(spot);
    const images = getSpotImages(spot).slice(0, 6);
    const gmapsLink = spot.lat && spot.lng
      ? `https://www.google.com/maps?q=${encodeURIComponent(`${spot.lat},${spot.lng}`)}`
      : '';

    return `
      <div class="popup-card">
        <div class="popup-title-row">
          <strong>${escapeHtml(spot.name)}</strong>
          <span class="spot-badge">L${eff.layer}</span>
        </div>
        ${titleImage ? `<img class="popup-hero" src="${titleImage}" alt="${escapeHtml(spot.name)}">` : ''}
        <div class="popup-meta">${escapeHtml(spot.spot_type || 'spot')} · ${formatStatus(eff.status)}${eff.planned_day ? ` · Tag ${escapeHtml(eff.planned_day)}` : ''}</div>
        <p class="popup-copy">${escapeHtml(eff.comment || spot.description || spot.address || 'Noch keine Beschreibung hinterlegt.')}</p>
        <div class="popup-flag-row">
          ${eff.is_favorite ? `<span class="mini-tag">★ Favorit</span>` : ''}
          ${eff.visited ? `<span class="mini-tag">✓ besucht</span>` : ''}
          ${eff.priority ? `<span class="mini-tag">Prio ${escapeHtml(eff.priority)}</span>` : ''}
          ${eff.area ? `<span class="mini-tag">${escapeHtml(eff.area)}</span>` : ''}
        </div>
        ${images.length > 1 ? `<div class="popup-gallery">${images.map(img => `<img src="${img.url}" alt="${escapeHtml(spot.name)}">`).join('')}</div>` : ''}
        <div class="popup-actions">
          <button class="pill popup-action-btn" type="button" data-popup-edit="${spot.spot_id}" ${(!state.user || !state.selectedProjectId) ? 'disabled' : ''}>Bearbeiten</button>
          <button class="pill popup-action-btn" type="button" data-popup-fav="${spot.spot_id}" ${(!state.user || !state.selectedProjectId) ? 'disabled' : ''}>${eff.is_favorite ? 'Unfavorit' : 'Favorit'}</button>
          <button class="pill popup-action-btn" type="button" data-popup-layer="${spot.spot_id}" ${(!state.user || !state.selectedProjectId) ? 'disabled' : ''}>Layer +1</button>
          ${gmapsLink ? `<a class="pill popup-link-btn" href="${gmapsLink}" target="_blank" rel="noopener">GMaps</a>` : ''}
        </div>
      </div>
    `;
  }

  function bindPopupActions(spot) {
    const root = document.querySelector('.leaflet-popup-content');
    if (!root) return;
    root.querySelector('[data-popup-edit]')?.addEventListener('click', () => openSpotEditor(spot));
    root.querySelector('[data-popup-fav]')?.addEventListener('click', () => toggleFavorite(String(spot.spot_id)));
    root.querySelector('[data-popup-layer]')?.addEventListener('click', () => {
      const eff = spotEffectiveState(spot);
      quickSetLayer(String(spot.spot_id), Math.min(8, Number(eff.layer || 1) + 1));
    });
  }

  async function quickSetLayer(spotId, layer) {
    if (!client || !state.user || !state.selectedProjectId) {
      toast('Login + aktives Projekt nötig.');
      return;
    }
    const existing = state.projectSpotMap.get(String(spotId));
    const payload = buildProjectSpotPayload(spotId, {
      layer: Math.max(1, Math.min(8, Number(layer) || 1)),
      status: existing?.status ?? 'none',
      visited: existing?.visited ?? false,
      is_favorite: existing?.is_favorite ?? false,
      comment: existing?.comment ?? null,
      priority: existing?.priority ?? null,
      planned_day: existing?.planned_day ?? existing?.day ?? null,
      area: existing?.area ?? null,
    });

    const saved = await upsertProjectSpot(payload, 'Layer konnte nicht gespeichert werden.');
    if (!saved) return;
    toast('Layer gespeichert.');
  }

  async function toggleFavorite(spotId) {
    if (!client || !state.user || !state.selectedProjectId) {
      toast('Login + aktives Projekt nötig.');
      return;
    }
    const existing = state.projectSpotMap.get(String(spotId));
    const payload = buildProjectSpotPayload(spotId, {
      layer: existing?.layer ?? 1,
      status: existing?.status ?? 'none',
      visited: existing?.visited ?? false,
      is_favorite: !(existing?.is_favorite ?? false),
      comment: existing?.comment ?? null,
      priority: existing?.priority ?? null,
      planned_day: existing?.planned_day ?? existing?.day ?? null,
      area: existing?.area ?? null,
    });

    const saved = await upsertProjectSpot(payload, 'Favorit konnte nicht gespeichert werden.');
    if (!saved) return;
    toast(saved.is_favorite ? 'Favorit gespeichert.' : 'Favorit entfernt.');
  }

  function buildProjectSpotPayload(spotId, values = {}) {
    const payload = {
      project_id: state.selectedProjectId,
      spot_id: spotId,
      layer: values.layer ?? 1,
      status: values.status ?? 'none',
      visited: values.visited ?? false,
      is_favorite: values.is_favorite ?? false,
      comment: values.comment ?? null,
      priority: values.priority ?? null,
    };

    if (Object.prototype.hasOwnProperty.call(values, 'planned_day')) payload.planned_day = values.planned_day;
    if (Object.prototype.hasOwnProperty.call(values, 'day')) payload.day = values.day;
    if (Object.prototype.hasOwnProperty.call(values, 'area')) payload.area = values.area;
    return payload;
  }

  async function upsertProjectSpot(payload, errorMessage) {
    let workingPayload = { ...payload };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await client
        .from('project_spots')
        .upsert(workingPayload, { onConflict: 'project_id,spot_id' })
        .select()
        .single();

      if (!error) {
        state.projectSpotMap.set(String(data.spot_id), data);
        syncSpotUi();
        return data;
      }

      const missingColumn = extractMissingColumn(error);
      if (missingColumn && Object.prototype.hasOwnProperty.call(workingPayload, missingColumn)) {
        delete workingPayload[missingColumn];
        continue;
      }

      console.error(error);
      toast(errorMessage || error.message);
      return null;
    }

    toast(errorMessage || 'Spot konnte nicht gespeichert werden.');
    return null;
  }


  function extractMissingColumn(error) {
    const message = [error?.message, error?.details, error?.hint].filter(Boolean).join(' ');
    const match = message.match(/column ['"]?([a-zA-Z0-9_]+)['"]?/i);
    return match ? match[1] : null;
  }

  function getSpotById(spotId) {
    return state.spots.find(s => String(s.spot_id) === String(spotId)) || null;
  }

  function setActiveSpot(spotId) {
    state.activeSpotId = String(spotId);
    qsa('[data-spot-card]').forEach(card => card.classList.toggle('active', card.dataset.spotCard === state.activeSpotId));
  }

  function focusSpotOnMap(spot, openPopup = false) {
    if (!spot || !state.map) return;
    setActiveSpot(spot.spot_id);
    state.map.setView([Number(spot.lat), Number(spot.lng)], Math.max(state.map.getZoom(), 15), { animate: true });
    const marker = state.markerMap.get(String(spot.spot_id));
    if (marker && openPopup) {
      setTimeout(() => marker.openPopup(), 120);
    }
  }

  function syncSpotUi() {
    updateMarkers();
    renderSpotList();
    renderPlanningPanel();
    renderLayerPanel();
    renderAreasPanel();
  }

  function renderPlanningPanel() {
    const stats = qs('#planningStats');
    const list = qs('#planningList');
    if (!stats || !list) return;

    const rows = [...state.projectSpotMap.values()];
    if (!state.selectedProjectId) {
      stats.innerHTML = `<div class="helper-text">Wähle ein Projekt, dann wird aus der Deko ein richtiger Plan.</div>`;
      list.innerHTML = `<div class="empty-state">Noch kein Projekt aktiv.</div>`;
      return;
    }

    const visited = rows.filter(r => r.visited).length;
    const favorites = rows.filter(r => r.is_favorite).length;
    const planned = rows.filter(r => r.planned_day ?? r.day).length;
    const open = rows.filter(r => (r.status || 'none') === 'none').length;

    stats.innerHTML = `
      <div class="planning-stat"><strong>${rows.length}</strong><span>im Projekt</span></div>
      <div class="planning-stat"><strong>${favorites}</strong><span>Favoriten</span></div>
      <div class="planning-stat"><strong>${visited}</strong><span>Besucht</span></div>
      <div class="planning-stat"><strong>${planned}</strong><span>mit Tag</span></div>
    `;

    const grouped = new Map();
    rows.forEach(row => {
      const key = row.planned_day ?? row.day ?? 'ohne-tag';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    });
    const sortedKeys = [...grouped.keys()].sort((a, b) => {
      if (a === 'ohne-tag') return 1;
      if (b === 'ohne-tag') return -1;
      return String(a).localeCompare(String(b), 'de', { numeric: true });
    });

    list.innerHTML = sortedKeys.map(key => {
      const items = grouped.get(key) || [];
      const label = key === 'ohne-tag' ? 'Ohne Tag' : `Tag ${escapeHtml(key)}`;
      return `
        <div class="planning-group">
          <div class="planning-group-head">
            <strong>${label}</strong>
            <span class="muted">${items.length} Spots</span>
          </div>
          <div class="planning-group-list">
            ${items.slice(0, 10).map(item => {
              const spot = getSpotById(item.spot_id);
              return `<button class="mini-log-item planning-item" type="button" data-plan-spot="${item.spot_id}">${escapeHtml(spot?.name || item.spot_id)} · ${formatStatus(item.status || 'none')}</button>`;
            }).join('')}
          </div>
        </div>
      `;
    }).join('') || `<div class="mini-log-item">${open ? `${open} Spots warten noch auf ihre erste Einordnung.` : 'Noch keine Projektspots.'}</div>`;

    qsa('[data-plan-spot]', list).forEach(btn => {
      btn.addEventListener('click', () => {
        const spot = getSpotById(btn.dataset.planSpot);
        focusSpotOnMap(spot, true);
      });
    });
  }

  function renderLayerPanel() {
    const list = qs('#layerPanelList');
    if (!list) return;
    const rows = [...state.projectSpotMap.values()];
    if (!state.selectedProjectId) {
      list.innerHTML = `<div class="empty-state">Aktiviere ein Projekt, dann bekommt jeder Layer echte Muskeln.</div>`;
      return;
    }
    const counts = new Map();
    for (let i = 1; i <= 8; i += 1) counts.set(i, 0);
    rows.forEach(row => counts.set(Number(row.layer || 1), (counts.get(Number(row.layer || 1)) || 0) + 1));
    list.innerHTML = Array.from({ length: 8 }, (_, index) => index + 1).map(layer => `
      <div class="layer-chip">
        <span><span class="swatch" style="background:${layerColor(layer)}"></span> Layer ${layer}</span>
        <span class="muted">${counts.get(layer) || 0} Spots</span>
      </div>
    `).join('');
  }

  function renderAreasPanel() {
    const list = qs('#areasPanelList');
    if (!list) return;
    const counter = new Map();
    state.spots.forEach(spot => {
      const eff = spotEffectiveState(spot);
      const key = String(eff.area || spot.area || 'ohne area').trim() || 'ohne area';
      counter.set(key, (counter.get(key) || 0) + 1);
    });
    const entries = [...counter.entries()].sort((a, b) => b[1] - a[1]);
    list.innerHTML = entries.length
      ? entries.map(([area, count]) => `<div class="area-chip"><span>${escapeHtml(area)}</span><span class="muted">${count}</span></div>`).join('')
      : `<div class="empty-state">Noch keine Areas im geladenen Material gefunden.</div>`;
  }

  function bindFloatingPanels() {
    const panels = qsa('.floating-panel');
    const dockButtons = qsa('[data-panel-target]');
    if (!panels.length) return;

    const panelState = {};
    let panelTransparency = parseFloat(localStorage.getItem('spotmap.panelTransparency') || '0.5');
    if (Number.isNaN(panelTransparency)) panelTransparency = 0.5;
    panelTransparency = Math.max(0.18, Math.min(0.9, panelTransparency));

    function applyPanelTransparency(value) {
      panelTransparency = Math.max(0.18, Math.min(0.9, Number(value) || 0.5));
      document.documentElement.style.setProperty('--panel-alpha', String(panelTransparency));
      document.documentElement.style.setProperty('--panel-strong-alpha', String(Math.min(0.98, panelTransparency + 0.12)));
      try { localStorage.setItem('spotmap.panelTransparency', String(panelTransparency)); } catch (_) {}
      const slider = qs('#panelTransparencyRange');
      const label = qs('#panelTransparencyValue');
      if (slider && slider !== document.activeElement) slider.value = String(panelTransparency);
      if (label) label.textContent = `${Math.round(panelTransparency * 100)}%`;
    }
    applyPanelTransparency(panelTransparency);

    function getPanel(name) {
      return qs(`.floating-panel[data-panel="${name}"]`);
    }

    function setDockActive(name, active) {
      dockButtons.forEach(btn => btn.classList.toggle('is-active', btn.dataset.panelTarget === name && active));
    }

    function showPanel(name, pinned = null) {
      const panel = getPanel(name);
      if (!panel) return;
      panel.classList.add('show');
      panelState[name] = panelState[name] || { pinned: false };
      if (pinned !== null) panelState[name].pinned = pinned;
      panel.dataset.pinned = panelState[name].pinned ? 'true' : 'false';
      const pinBtn = qs('[data-pin-panel]', panel);
      pinBtn?.classList.toggle('is-pinned', panelState[name].pinned);
      setDockActive(name, true);
      requestMapResize();
    }

    function hidePanel(name, force = false) {
      const panel = getPanel(name);
      if (!panel) return;
      panelState[name] = panelState[name] || { pinned: false };
      if (panelState[name].pinned && !force) return;
      panel.classList.remove('show');
      setDockActive(name, false);
      requestMapResize();
    }

    function togglePanel(name) {
      const panel = getPanel(name);
      if (!panel) return;
      panelState[name] = panelState[name] || { pinned: false };
      const isShown = panel.classList.contains('show');
      if (!isShown) {
        showPanel(name, false);
      } else if (panelState[name].pinned) {
        panelState[name].pinned = false;
        hidePanel(name, true);
      } else {
        hidePanel(name, true);
      }
    }

    dockButtons.forEach(btn => {
      const name = btn.dataset.panelTarget;
      btn.addEventListener('mouseenter', () => {
        panelState[name] = panelState[name] || { pinned: false };
        if (!panelState[name].pinned) showPanel(name, false);
      });
      btn.addEventListener('click', () => {
        panelState[name] = panelState[name] || { pinned: false };
        if (!panelState[name].pinned) {
          panelState[name].pinned = true;
          showPanel(name, true);
          return;
        }
        panelState[name].pinned = false;
        hidePanel(name, true);
      });
    });

    panels.forEach(panel => {
      const name = panel.dataset.panel;
      panelState[name] = { pinned: false };
      panel.dataset.pinned = 'false';

      panel.addEventListener('mouseleave', () => {
        if (!panelState[name].pinned) hidePanel(name);
      });

      panel.addEventListener('mouseenter', () => {
        if (!panel.classList.contains('show')) showPanel(name, panelState[name].pinned);
      });

      qs('[data-close-panel]', panel)?.addEventListener('click', () => {
        panelState[name].pinned = false;
        hidePanel(name, true);
      });

      qs('[data-pin-panel]', panel)?.addEventListener('click', () => {
        panelState[name].pinned = !panelState[name].pinned;
        showPanel(name, panelState[name].pinned);
        if (!panelState[name].pinned) hidePanel(name, true);
      });

      makePanelDraggable(panel);
    });

    qs('#settingsToggleBtn')?.addEventListener('click', () => togglePanel('settings'));

    qs('#panelTransparencyRange')?.addEventListener('input', (e) => {
      applyPanelTransparency(e.target.value);
    });
  }

  function makePanelDraggable(panel) {
    const handle = qs('[data-drag-handle]', panel);
    if (!handle) return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let rectX = 0;
    let rectY = 0;

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.left = `${Math.max(8, rectX + dx)}px`;
      panel.style.top = `${Math.max(8, rectY + dy)}px`;
      panel.style.right = 'auto';
    };

    const onUp = () => {
      dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      requestMapResize();
    };

    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      rectX = rect.left;
      rectY = rect.top;
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  function requestMapResize() {
    setTimeout(() => state.map?.invalidateSize(), 40);
  }

  function initUiScaffolding() {
    bindFloatingPanels();
    initFilterScaffold();
  }

  function initFilterScaffold() {
    const typeSelect = qs('#spotTypeFilter');
    const searchInput = qs('#spotSearchInput');
    const favoritesToggle = qs('#favoritesOnlyToggle');
    if (typeSelect) {
      const types = Array.from(new Set(state.spots.map(spot => spot.spot_type).filter(Boolean))).sort();
      typeSelect.innerHTML = `<option value="">Alle Spottypen</option>${types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}`;
    }
    if (searchInput && !searchInput.dataset.bound) {
      searchInput.dataset.bound = 'true';
      searchInput.addEventListener('input', () => {
        renderSpotList(searchInput.value.trim().toLowerCase());
        updateMarkers();
      });
    }
    if (typeSelect && !typeSelect.dataset.bound) {
      typeSelect.dataset.bound = 'true';
      typeSelect.addEventListener('change', () => {
        renderSpotList(searchInput?.value?.trim().toLowerCase() || '');
        updateMarkers();
      });
    }
    if (favoritesToggle && !favoritesToggle.dataset.bound) {
      favoritesToggle.dataset.bound = 'true';
      favoritesToggle.addEventListener('change', () => {
        renderSpotList(searchInput?.value?.trim().toLowerCase() || '');
        updateMarkers();
      });
    }
    if (favoritesToggle) favoritesToggle.disabled = !state.selectedProjectId;
  }

  function bindCityUi() {
    qs('#openProjectModal')?.addEventListener('click', () => openProjectModal());
    qs('#editProjectBtn')?.addEventListener('click', () => openProjectModal(true));
    qs('#closeProjectModal')?.addEventListener('click', () => toggleModal(false));
    qs('#projectModalBackdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'projectModalBackdrop') toggleModal(false);
    });

    qs('#createProjectForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveProjectFromModal();
    });

    qs('#archiveProjectBtn')?.addEventListener('click', async () => {
      await archiveProject();
    });

    qs('#authForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await signIn();
    });

    qs('#logoutBtn')?.addEventListener('click', async () => {
      if (!client) return;
      await client.auth.signOut();
      toast('Ausgeloggt.');
    });

    qs('#refreshBtn')?.addEventListener('click', async () => {
      await Promise.all([loadProjects(), loadSpots(), loadSpotImages()]);
      syncSpotUi();
      initFilterScaffold();
      toast('Daten neu geladen.');
    });

    qs('#spotEditorBackdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'spotEditorBackdrop') toggleSpotEditor(false);
    });
    qs('#closeSpotEditor')?.addEventListener('click', () => toggleSpotEditor(false));
    qs('#spotEditorForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveSpotEditor();
    });
    qs('#quickRemoveFavoriteBtn')?.addEventListener('click', async () => {
      const spotId = qs('#spotEditorSpotId')?.value;
      if (!spotId) return;
      const existing = state.projectSpotMap.get(String(spotId));
      if (!existing?.is_favorite) {
        toast('Der Spot ist aktuell gar kein Favorit.');
        return;
      }
      await toggleFavorite(String(spotId));
      const spot = getSpotById(spotId);
      if (spot) openSpotEditor(spot);
    });
  }

  function toggleModal(show) {
    qs('#projectModalBackdrop')?.classList.toggle('show', show);
    if (!show) qs('#createProjectForm')?.reset();
  }

  function openProjectModal(editMode = false) {
    if (!state.user) {
      toast('Login nötig.');
      return;
    }
    const form = qs('#createProjectForm');
    if (!form) return;

    form.reset();
    qs('#projectModalTitle').textContent = editMode ? 'Projekt bearbeiten' : 'Neues Projekt';
    qs('#projectFormMode').value = editMode ? 'edit' : 'create';
    const archiveBtn = qs('#archiveProjectBtn');
    if (archiveBtn) archiveBtn.style.display = editMode && state.selectedProjectId ? 'inline-flex' : 'none';

    if (editMode) {
      const project = state.projects.find(p => p.id === state.selectedProjectId);
      if (!project) {
        toast('Kein aktives Projekt zum Bearbeiten.');
        return;
      }
      qs('#projectId').value = project.id;
      qs('#projectName').value = project.name || '';
      qs('#projectDescription').value = project.description || '';
      qs('#projectIsPublic').checked = !!project.is_public;
    } else {
      qs('#projectId').value = '';
    }

    toggleModal(true);
  }

  async function saveProjectFromModal() {
    if (!client || !state.user || !state.city) {
      toast('Login nötig.');
      return;
    }

    const mode = qs('#projectFormMode')?.value || 'create';
    const projectId = qs('#projectId')?.value?.trim();
    const name = qs('#projectName')?.value?.trim();
    const description = qs('#projectDescription')?.value?.trim();
    const isPublic = !!qs('#projectIsPublic')?.checked;

    if (!name) {
      toast('Projektname fehlt.');
      return;
    }

    if (mode === 'edit' && projectId) {
      const { data, error } = await client
        .from('projects')
        .update({
          name,
          description: description || null,
          is_public: isPublic,
        })
        .eq('id', projectId)
        .select()
        .single();

      if (error) {
        console.error(error);
        toast(`Projekt konnte nicht gespeichert werden: ${error.message}`);
        return;
      }

      state.projects = state.projects.map(project => project.id === projectId ? data : project);
      renderProjectList();
      toggleModal(false);
      toast('Projekt aktualisiert.');
      return;
    }

    const { data, error } = await client
      .from('projects')
      .insert({
        city_id: state.city.city_id,
        owner_user_id: state.user.id,
        name,
        description: description || null,
        is_public: isPublic,
      })
      .select()
      .single();

    if (error) {
      console.error(error);
      toast(`Projekt konnte nicht erstellt werden: ${error.message}`);
      return;
    }

    toggleModal(false);
    state.projects.unshift(data);
    state.selectedProjectId = data.id;
    renderProjectList();
    await loadProjectSpots();
    toast('Projekt erstellt. Standardzustand läuft über Variante B – also ohne unnötigen Tabellen-Kebab.');
  }

  async function archiveProject() {
    if (!client || !state.selectedProjectId) return;
    const project = state.projects.find(p => p.id === state.selectedProjectId);
    if (!project) return;

    const ok = window.confirm(`Projekt „${project.name}“ archivieren?`);
    if (!ok) return;

    const { error } = await client
      .from('projects')
      .update({ is_archived: true })
      .eq('id', project.id);

    if (error) {
      console.error(error);
      toast(`Projekt konnte nicht archiviert werden: ${error.message}`);
      return;
    }

    toggleModal(false);
    await loadProjects();
    renderProjectList();
    toast('Projekt archiviert.');
  }

  function openSpotEditor(spot) {
    if (!spot) return;
    if (!state.user || !state.selectedProjectId) {
      toast('Zum Bearbeiten brauchst du Login + aktives Projekt.');
      return;
    }

    const eff = spotEffectiveState(spot);
    const images = getSpotImages(spot);
    qs('#spotEditorSpotId').value = String(spot.spot_id);
    qs('#spotEditorTitle').textContent = `${spot.name || 'Spot'} bearbeiten`;
    qs('#spotEditorMeta').textContent = `${spot.spot_type || 'spot'} · ${spot.address || 'ohne Adresse'}`;
    qs('#editLayer').value = String(eff.layer || 1);
    qs('#editStatus').value = String(eff.status || 'none');
    qs('#editComment').value = eff.comment || '';
    qs('#editVisited').checked = !!eff.visited;
    qs('#editFavorite').checked = !!eff.is_favorite;
    qs('#editPriority').value = eff.priority ?? '';
    qs('#editPlannedDay').value = eff.planned_day ?? '';
    qs('#editArea').value = eff.area ?? '';

    const preview = qs('#spotEditorPreview');
    if (preview) {
      preview.innerHTML = `
        <div class="spot-editor-preview-card">
          ${images[0]?.url ? `<img src="${images[0].url}" alt="${escapeHtml(spot.name)}">` : `<div class="spot-thumb-fallback spot-editor-fallback">📸</div>`}
          <div class="spot-editor-preview-copy">
            <strong>${escapeHtml(spot.name)}</strong>
            <p>${escapeHtml(spot.description || spot.address || 'Noch kein Beschreibungstext im Spotdatensatz.')}</p>
          </div>
        </div>
        ${images.length > 1 ? `<div class="popup-gallery">${images.slice(0, 6).map(img => `<img src="${img.url}" alt="${escapeHtml(spot.name)}">`).join('')}</div>` : ''}
      `;
    }

    toggleSpotEditor(true);
  }

  function toggleSpotEditor(show) {
    qs('#spotEditorBackdrop')?.classList.toggle('show', show);
  }

  async function saveSpotEditor() {
    if (!client || !state.selectedProjectId || !state.user) {
      toast('Login + aktives Projekt nötig.');
      return;
    }

    const spotId = qs('#spotEditorSpotId')?.value;
    if (!spotId) return;

    const values = {
      layer: Number(qs('#editLayer')?.value || 1),
      status: qs('#editStatus')?.value || 'none',
      comment: qs('#editComment')?.value?.trim() || null,
      visited: !!qs('#editVisited')?.checked,
      is_favorite: !!qs('#editFavorite')?.checked,
      priority: qs('#editPriority')?.value?.trim() || null,
      planned_day: qs('#editPlannedDay')?.value?.trim() || null,
      area: qs('#editArea')?.value?.trim() || null,
    };

    const payload = buildProjectSpotPayload(String(spotId), values);
    const saved = await upsertProjectSpot(payload, 'Spot konnte nicht gespeichert werden.');
    if (!saved) return;

    toggleSpotEditor(false);
    const spot = getSpotById(spotId);
    if (spot) focusSpotOnMap(spot, true);
    toast('Spot gespeichert.');
  }

  async function signIn() {
    if (!client) {
      toast('Supabase Config fehlt.');
      return;
    }
    const email = qs('#authEmail')?.value?.trim();
    const password = qs('#authPassword')?.value?.trim();
    if (!email || !password) {
      toast('E-Mail und Passwort eingeben.');
      return;
    }
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      console.error(error);
      toast(`Login fehlgeschlagen: ${error.message}`);
      return;
    }
    toast('Login erfolgreich.');
  }

  function titleCase(value) {
    return String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function layerColor(layer) {
    const colors = ['#94a3b8', '#38bdf8', '#34d399', '#fbbf24', '#fb7185', '#c084fc', '#f472b6', '#f97316'];
    return colors[Math.max(1, Math.min(8, Number(layer) || 1)) - 1];
  }

  function formatStatus(value) {
    const map = {
      none: 'offen',
      maybe: 'vielleicht',
      planned: 'geplant',
      done: 'done',
      skipped: 'übersprungen',
    };
    return map[value] || value || 'offen';
  }

  function formatDate(value) {
    if (!value) return '—';
    try {
      return new Date(value).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch {
      return String(value);
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  window.SpotmapApp = { quickSetLayer, toggleFavorite, openSpotEditor };
  bootstrap();
})();
