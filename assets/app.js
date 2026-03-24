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
    map: null,
    markersLayer: null,
    loading: false,
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

    client.auth.onAuthStateChange((_event, session) => {
      state.session = session || null;
      state.user = session?.user || null;
      renderAuthState();
      loadProjects();
    });
  }

  function renderAuthState() {
    const email = qs('#authUserEmail');
    const guest = qs('#guestHint');
    const authOnly = qsa('[data-auth-only]');
    if (email) email.textContent = state.user?.email || 'Nicht eingeloggt';
    if (guest) guest.style.display = state.user ? 'none' : 'block';
    authOnly.forEach(el => el.disabled = !state.user);
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
    await Promise.all([loadSpots(), loadProjects()]);
    initMap();
    renderSpotList();
    renderProjectList();
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
    if (!client) {
      state.spots = [];
      return;
    }
    const { data, error } = await client
      .from('spots')
      .select('spot_id, city_id, name, lat, lng, address, description, spot_type, difficulty, roofed, lights, bust_risk, is_hidden')
      .eq('city_id', state.city.city_id)
      .eq('is_hidden', false)
      .order('name', { ascending: true });

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
      renderProjectList();
      await loadProjectSpots();
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

    state.projects = data || [];
    state.selectedProjectId = state.projects[0]?.id || null;
    renderProjectList();
    await loadProjectSpots();
  }

  async function loadProjectSpots() {
    state.projectSpotMap = new Map();
    if (!client || !state.selectedProjectId) {
      updateMarkers();
      renderSpotList();
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
      return;
    }

    (data || []).forEach(row => state.projectSpotMap.set(row.spot_id, row));
    updateMarkers();
    renderSpotList();
  }

  function renderProjectList() {
    const wrapper = qs('#projectList');
    const current = qs('#currentProjectInfo');
    if (!wrapper) return;

    if (!state.user) {
      wrapper.innerHTML = `<div class="empty-state">Login nötig, um Projekte zu sehen oder anzulegen.</div>`;
      if (current) current.textContent = 'Kein Projekt aktiv';
      return;
    }

    if (!state.projects.length) {
      wrapper.innerHTML = `<div class="empty-state">Noch kein Projekt in ${state.city?.name || 'dieser Stadt'}. Zeit für den ersten Kickflip in Tabellenform.</div>`;
      if (current) current.textContent = 'Kein Projekt aktiv';
      return;
    }

    wrapper.innerHTML = state.projects.map(project => `
      <button class="project-item ${project.id === state.selectedProjectId ? 'active' : ''}" data-project-id="${project.id}">
        <h4>${escapeHtml(project.name)}</h4>
        <p>${escapeHtml(project.description || 'Ohne Beschreibung. Noch sehr geheimagentig.')}</p>
      </button>
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
  }

  function spotEffectiveState(spot) {
    const row = state.projectSpotMap.get(spot.spot_id);
    return {
      layer: row?.layer ?? 1,
      comment: row?.comment ?? '',
      status: row?.status ?? 'none',
      visited: row?.visited ?? false,
      is_favorite: row?.is_favorite ?? false,
      priority: row?.priority ?? null,
    };
  }

  function renderSpotList(searchTerm = '') {
    const wrapper = qs('#spotList');
    const count = qs('#spotCount');
    if (!wrapper) return;

    const typeFilter = qs('#spotTypeFilter')?.value || '';
    const visibleSpots = state.spots.filter(spot => {
      const matchesSearch = !searchTerm || String(spot.name || '').toLowerCase().includes(searchTerm);
      const matchesType = !typeFilter || spot.spot_type === typeFilter;
      return matchesSearch && matchesType;
    });

    if (count) count.textContent = `${visibleSpots.length} Spots`; 

    if (!visibleSpots.length) {
      wrapper.innerHTML = `<div class="empty-state">Noch keine Spots geladen. Vielleicht steht die DB noch mit Helm am Rand und macht sich warm.</div>`;
      return;
    }

    wrapper.innerHTML = visibleSpots.slice(0, 120).map(spot => {
      const eff = spotEffectiveState(spot);
      return `
        <button class="spot-item" data-spot-id="${spot.spot_id}">
          <h4>${escapeHtml(spot.name)}</h4>
          <p>Layer ${eff.layer} · ${escapeHtml(spot.spot_type || 'spot')} · ${eff.status}</p>
        </button>
      `;
    }).join('');

    qsa('[data-spot-id]', wrapper).forEach(btn => {
      btn.addEventListener('click', () => {
        const spot = state.spots.find(s => s.spot_id === btn.dataset.spotId);
        focusSpotOnMap(spot);
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

    state.spots.forEach(spot => {
      const eff = spotEffectiveState(spot);
      const marker = L.circleMarker([spot.lat, spot.lng], {
        radius: Math.max(6, 5 + eff.layer),
        weight: 1,
        opacity: 1,
        fillOpacity: 0.82,
        color: layerColor(eff.layer),
        fillColor: layerColor(eff.layer)
      });

      marker.bindPopup(`
        <div style="min-width:220px">
          <strong>${escapeHtml(spot.name)}</strong><br>
          <span style="color:#cbd5e1">Layer ${eff.layer} · ${escapeHtml(spot.spot_type || 'spot')} · ${eff.status}</span>
          <p style="margin:.5rem 0 0">${escapeHtml(spot.description || spot.address || 'Noch keine Beschreibung hinterlegt.')}</p>
          ${state.user && state.selectedProjectId ? `<div style="margin-top:.65rem;display:flex;gap:.5rem;flex-wrap:wrap">
            <button class="pill" onclick="window.SpotmapApp.quickSetLayer('${spot.spot_id}', ${Math.min(8, eff.layer + 1)})">Layer +1</button>
            <button class="pill" onclick="window.SpotmapApp.toggleFavorite('${spot.spot_id}')">Favorit</button>
          </div>` : ''}
        </div>
      `);
      state.markersLayer.addLayer(marker);
    });
  }

  async function quickSetLayer(spotId, layer) {
    if (!client || !state.user || !state.selectedProjectId) {
      toast('Login + aktives Projekt nötig.');
      return;
    }
    const existing = state.projectSpotMap.get(spotId);
    const payload = {
      project_id: state.selectedProjectId,
      spot_id: spotId,
      layer: Math.max(1, Math.min(8, layer)),
      status: existing?.status ?? 'none',
      visited: existing?.visited ?? false,
      is_favorite: existing?.is_favorite ?? false,
      comment: existing?.comment ?? null,
      priority: existing?.priority ?? null,
    };

    const { data, error } = await client
      .from('project_spots')
      .upsert(payload, { onConflict: 'project_id,spot_id' })
      .select()
      .single();

    if (error) {
      console.error(error);
      toast('Layer konnte nicht gespeichert werden.');
      return;
    }

    state.projectSpotMap.set(spotId, data);
    updateMarkers();
    renderSpotList();
    toast('Layer gespeichert.');
  }

  async function toggleFavorite(spotId) {
    if (!client || !state.user || !state.selectedProjectId) {
      toast('Login + aktives Projekt nötig.');
      return;
    }
    const existing = state.projectSpotMap.get(spotId);
    const payload = {
      project_id: state.selectedProjectId,
      spot_id: spotId,
      layer: existing?.layer ?? 1,
      status: existing?.status ?? 'none',
      visited: existing?.visited ?? false,
      is_favorite: !(existing?.is_favorite ?? false),
      comment: existing?.comment ?? null,
      priority: existing?.priority ?? null,
    };

    const { data, error } = await client
      .from('project_spots')
      .upsert(payload, { onConflict: 'project_id,spot_id' })
      .select()
      .single();

    if (error) {
      console.error(error);
      toast('Favorit konnte nicht gespeichert werden.');
      return;
    }
    state.projectSpotMap.set(spotId, data);
    updateMarkers();
    renderSpotList();
    toast('Favorit umgeschaltet.');
  }

  function focusSpotOnMap(spot) {
    if (!spot || !state.map) return;
    state.map.setView([spot.lat, spot.lng], Math.max(state.map.getZoom(), 15), { animate: true });
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
    if (typeSelect) {
      const types = Array.from(new Set(state.spots.map(spot => spot.spot_type).filter(Boolean))).sort();
      typeSelect.innerHTML = `<option value="">Alle Spottypen</option>${types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}`;
    }
    if (searchInput) {
      searchInput.addEventListener('input', () => renderSpotList(searchInput.value.trim().toLowerCase()));
    }
    typeSelect?.addEventListener('change', () => renderSpotList(searchInput?.value?.trim().toLowerCase() || ''));
  }


  function bindCityUi() {
    qs('#openProjectModal')?.addEventListener('click', () => toggleModal(true));
    qs('#closeProjectModal')?.addEventListener('click', () => toggleModal(false));
    qs('#projectModalBackdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'projectModalBackdrop') toggleModal(false);
    });

    qs('#createProjectForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await createProject();
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
      await Promise.all([loadProjects(), loadSpots()]);
      updateMarkers();
      renderSpotList(qs('#spotSearchInput')?.value?.trim().toLowerCase() || '');
      initFilterScaffold();
      toast('Daten neu geladen.');
    });
  }

  function toggleModal(show) {
    qs('#projectModalBackdrop')?.classList.toggle('show', show);
    if (!show) qs('#createProjectForm')?.reset();
  }

  async function createProject() {
    if (!client || !state.user || !state.city) {
      toast('Login nötig.');
      return;
    }
    const name = qs('#projectName')?.value?.trim();
    const description = qs('#projectDescription')?.value?.trim();
    const isPublic = !!qs('#projectIsPublic')?.checked;
    if (!name) {
      toast('Projektname fehlt.');
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
    return colors[Math.max(1, Math.min(8, layer)) - 1];
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  window.SpotmapApp = { quickSetLayer, toggleFavorite };
  bootstrap();
})();
