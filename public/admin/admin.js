import { t, setLang, applyTranslations, getCurrentLang } from '/admin/i18n.js';

const state = {
  page: 0,
  pageSize: 50,
  search: '',
  csvSource: '',
  contactStatus: '', // '' = tous, 'never' = jamais cold-mailés, 'contacted' = déjà partis
  groupId: '',     // '' = tous les salons, 'none' = sans groupe, '<id>' = groupe specifique
  groups: [],
  orphanCount: 0,
  total: 0,
  selectedSlugs: new Set(),  // slugs des lignes cochees (persiste entre pages)
  expandedCol: null,         // index 0-based de la colonne actuellement expandée (null = aucune)
};

// Persistance du groupe actif (utile pour reprendre apres reload)
const ACTIVE_GROUP_KEY = 'outil-coiffure-active-group';
state.groupId = localStorage.getItem(ACTIVE_GROUP_KEY) || '';

// Persistance de la taille de page (50 par defaut)
const PAGE_SIZE_KEY = 'outil-coiffure-page-size';
const ALLOWED_PAGE_SIZES = [50, 100, 500, 1000, 10000];
const storedPageSize = parseInt(localStorage.getItem(PAGE_SIZE_KEY), 10);
if (Number.isFinite(storedPageSize) && ALLOWED_PAGE_SIZES.includes(storedPageSize)) {
  state.pageSize = storedPageSize;
}

const $ = id => document.getElementById(id);

async function api(path, opts = {}) {
  // Ajoute toujours Accept: application/json pour eviter une redirection HTML
  // quand la session a expire (cas typique apres redeploy)
  const headers = { 'Accept': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers });
  if (res.status === 401) {
    location.href = '/admin/login';
    return;
  }
  // Si la reponse n'est pas du JSON (redirect rate, page d'erreur), gerer proprement
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (res.status === 0 || res.redirected) location.href = '/admin/login';
    throw new Error('Reponse inattendue (' + res.status + '). Reconnectez-vous.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Erreur');
  }
  return res.json();
}

async function refreshAuth() {
  const me = await api('/admin/me');
  if (me && me.email) $('user-email').textContent = me.email;
}

function statsParams() {
  if (state.groupId) return '?group_id=' + encodeURIComponent(state.groupId);
  return '';
}

async function loadStats() {
  const stats = await api('/api/stats' + statsParams());
  $('stat-total').textContent = stats.total;
  $('stat-with-screenshot').textContent = stats.withScreenshot;
  $('stat-without-screenshot').textContent = stats.withoutScreenshot;
  $('stat-csv-sources').textContent = stats.csvSources.length;
  if ($('stat-clean-names')) $('stat-clean-names').textContent = stats.withCleanName ?? '—';
  if ($('stat-never-contacted')) $('stat-never-contacted').textContent = stats.neverContacted ?? '—';

  const select = $('csv-source-filter');
  const current = select.value;
  select.innerHTML = `<option value="">${escapeHtml(t('table.all_sources'))}</option>` +
    stats.csvSources.map(c => `<option value="${escapeHtml(c.csv_source)}">${escapeHtml(c.csv_source)} (${c.n})</option>`).join('');
  select.value = current;
}

async function loadSalons() {
  const params = new URLSearchParams({
    limit: state.pageSize,
    offset: state.page * state.pageSize,
    search: state.search,
    csv_source: state.csvSource
  });
  if (state.groupId) params.set('group_id', state.groupId);
  if (state.contactStatus) params.set('contact_status', state.contactStatus);
  const data = await api('/api/salons?' + params);
  state.total = data.total;
  const tbody = $('salons-tbody');
  tbody.innerHTML = data.rows.map(salonRow).join('');
  bindRowActions();
  // Met à jour TOUTES les paginations (haut + bas)
  updateAllPaginations(data);
  // Re-applique l'éventuelle colonne expandée après re-render
  if (state.expandedCol != null) applyExpandedColumn(state.expandedCol);
  updateBulkActionsBar();
}

function updateAllPaginations(data) {
  const total = data.total;
  const offset = data.offset;
  const rowCount = data.rows.length;
  const infoText = `${offset + 1}-${Math.min(offset + rowCount, total)} / ${total}`;
  document.querySelectorAll('[data-pagination]').forEach(pg => {
    pg.querySelector('.page-info').textContent = infoText;
    pg.querySelector('.pagination-prev').disabled = state.page === 0;
    pg.querySelector('.pagination-next').disabled = (state.page + 1) * state.pageSize >= total;
    const sel = pg.querySelector('.page-size-select');
    if (sel && parseInt(sel.value) !== state.pageSize) sel.value = String(state.pageSize);
  });
}

// Active la colonne d'index donné (0-based parmi les data-col-idx) — réduit toutes les autres
function applyExpandedColumn(colIdx) {
  state.expandedCol = colIdx;
  const table = document.querySelector('.salons-table');
  if (!table) return;
  // Reset toutes les classes col-expanded
  table.querySelectorAll('.col-expanded').forEach(el => el.classList.remove('col-expanded'));
  // colgroup : on cible le col à l'index correspondant (offset +1 car colgroup commence à 0 = checkbox)
  // data-col-idx démarre à 1 (nom_scrappe), donc l'index colgroup = colIdx + 1
  // Mais le 1er <col> est le checkbox (jamais expandable), donc on offset selon ce qu'on a déclaré
  // Les data-col-idx du HTML : 1=nom_scrappe, 2=nom_final, ..., 9=capture
  // colgroup : col[0]=checkbox, col[1]=nom_scrappe (= data-col-idx 1), ..., col[9]=capture (= data-col-idx 9)
  if (colIdx == null) return;
  const colgroup = table.querySelector('colgroup');
  if (colgroup) {
    const cols = colgroup.querySelectorAll('col');
    if (cols[colIdx]) cols[colIdx].classList.add('col-expanded');
  }
  // En-tête + cellules : nth-child se base sur la position dans la ligne, donc colIdx + 1 (CSS commence à 1)
  const ths = table.querySelectorAll('thead th');
  if (ths[colIdx]) ths[colIdx].classList.add('col-expanded');
  table.querySelectorAll('tbody tr').forEach(tr => {
    const tds = tr.querySelectorAll('td');
    if (tds[colIdx]) tds[colIdx].classList.add('col-expanded');
  });
  table.dataset.expandedCol = String(colIdx);
}

function clearExpandedColumn() {
  state.expandedCol = null;
  const table = document.querySelector('.salons-table');
  if (!table) return;
  table.querySelectorAll('.col-expanded').forEach(el => el.classList.remove('col-expanded'));
  delete table.dataset.expandedCol;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Pour les attributs HTML : echappement plus restreint (juste les guillemets et &)
function escapeAttr(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// SVG copy icon (cleaner than emoji)
const COPY_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function urlCell(displayText, fullUrl, hrefUrl) {
  if (!displayText) return '<span class="no-screenshot">—</span>';
  // hrefUrl par defaut = fullUrl (pour clic), displayText = text affiche
  const href = hrefUrl || fullUrl;
  return `<div class="url-with-copy">
    <a href="${escapeHtml(href)}" target="_blank" rel="noopener" class="url-link" title="${escapeHtml(fullUrl)}">${escapeHtml(displayText)}</a>
    <button class="btn-icon copy-btn" data-copy="${escapeHtml(fullUrl)}" title="${escapeHtml(t('cell.copy_tooltip'))}" aria-label="${escapeHtml(t('cell.copy_tooltip'))}">${COPY_ICON_SVG}</button>
  </div>`;
}

function publicBaseFromHost() {
  // Sur outil.maquickpage.fr (agency admin), le public est sur maquickpage.fr
  const host = window.location.host;
  if (host.startsWith('outil.')) {
    return window.location.protocol + '//' + host.slice('outil.'.length);
  }
  return window.location.origin;
}

function salonRow(r) {
  const publicBase = publicBaseFromHost();
  // URL Landing avec token = lien que le coiffeur reçoit par email :
  //   /preview/{slug}?token=xxx → onboarding visite + bouton "Modifier mon site"
  //   redirige correctement vers /admin/{slug}?token=xxx
  // Sans edit_token (rare), on retombe sur /preview/{slug} simple (mode visiteur).
  const landingUrl = r.edit_token
    ? `${publicBase}/preview/${r.slug}?token=${r.edit_token}`
    : `${publicBase}/preview/${r.slug}`;
  const editUrl = r.edit_token ? `${publicBase}/admin/${r.slug}?token=${r.edit_token}` : null;
  const fullLanding = landingUrl;
  const fullEdit = editUrl;

  // Cache-buster sur les images : on force le rechargement quand la capture est regenerée
  // (sinon le navigateur affiche la version en cache meme apres regeneration cote serveur).
  const cacheBuster = r.screenshot_generated_at ? '?v=' + encodeURIComponent(r.screenshot_generated_at) : '';
  const screenshotSrc = r.screenshot_path ? r.screenshot_path + cacheBuster : '';
  const screenshotCell = r.screenshot_path
    ? `<img class="screenshot-thumb" src="${screenshotSrc}" alt="capture" data-full="${screenshotSrc}">`
    : `<span class="no-screenshot">${t('cell.no_screenshot')}</span>`;

  const nomScrappe = r.nom || '';
  const nomFinal = (r.nom_clean && r.nom_clean.trim()) || r.nom || '';
  const wasModified = nomFinal !== nomScrappe;

  const nomScrappeCell = `<span class="nom-scrappe" title="${escapeHtml(nomScrappe)}">${escapeHtml(nomScrappe)}</span>`;
  const nomFinalCell = `
    <div class="nom-final-wrap ${wasModified ? 'modified' : ''}">
      <input type="text" class="nom-final-input" value="${escapeHtml(nomFinal)}" data-slug="${escapeHtml(r.slug)}" data-original="${escapeHtml(nomFinal)}" maxlength="200">
      <span class="nom-final-status"></span>
    </div>
  `;

  // URLs compactes : on affiche un texte court, le full URL est dans le hover/title
  const landingDisplay = '/preview/…';
  const editDisplay = editUrl ? '/admin/…' : null;

  // Presentations : clickables (ouvrent une modale)
  const presScrappee = r.presentation_scrappee || '';
  const presCorrigee = r.presentation_corrigee || '';
  const presScrappeeShort = presScrappee.length > 50 ? presScrappee.slice(0, 50) + '…' : presScrappee;
  const presCorrigeeShort = presCorrigee.length > 50 ? presCorrigee.slice(0, 50) + '…' : presCorrigee;
  const presScrappeeCell = presScrappee
    ? `<span class="presentation-cell" title="${escapeHtml(presScrappee)}">${escapeHtml(presScrappeeShort)}</span>`
    : `<span class="presentation-cell empty">—</span>`;
  const presCorrigeeCell = presCorrigee
    ? `<span class="presentation-cell modified" title="${escapeHtml(presCorrigee)}">${escapeHtml(presCorrigeeShort)}</span>`
    : `<span class="presentation-cell empty">${escapeHtml(t('cell.click_to_edit'))}</span>`;

  const checked = state.selectedSlugs.has(r.slug) ? 'checked' : '';

  // Domaines suggérés (array de strings, ex: ["32lesalon", "lesalon32", ...])
  const domains = Array.isArray(r.domain_suggestions) ? r.domain_suggestions : [];
  let domainsCell;
  if (domains.length === 0) {
    domainsCell = `<span class="domains-cell empty">${escapeHtml(t('cell.no_domain_suggestions'))}</span>`;
  } else {
    // 2 vues : preview (3 premiers + badge +N) en mode compact, full (tous, badges) en mode expanded
    const tooltip = domains.join(', ');
    const previewList = domains.slice(0, 3).map(d => escapeHtml(d)).join(', ');
    const previewMore = domains.length > 3 ? ` <span class="domains-more">+${domains.length - 3}</span>` : '';
    const fullList = domains.map(d => `<span class="domain-chip">${escapeHtml(d)}</span>`).join('');
    domainsCell = `
      <span class="domains-cell domains-cell-preview" title="${escapeAttr(tooltip)}">${previewList}${previewMore}</span>
      <span class="domains-cell-full">${fullList}</span>
    `;
  }

  return `<tr data-slug="${escapeHtml(r.slug)}" class="${checked ? 'row-selected' : ''}">
    <td class="col-checkbox">
      <input type="checkbox" class="row-checkbox" ${checked} aria-label="Sélectionner ${escapeHtml(r.slug)}">
    </td>
    <td>${nomScrappeCell}</td>
    <td>${nomFinalCell}</td>
    <td class="col-presentation"><div class="open-presentation" data-slug="${escapeHtml(r.slug)}">${presScrappeeCell}</div></td>
    <td class="col-presentation"><div class="open-presentation" data-slug="${escapeHtml(r.slug)}">${presCorrigeeCell}</div></td>
    <td class="col-domains">${domainsCell}</td>
    <td>${escapeHtml(r.ville || '')}</td>
    <td class="url-cell col-url-compact">${urlCell(landingDisplay, fullLanding, landingUrl)}</td>
    <td class="url-cell col-url-compact">${editDisplay ? urlCell(editDisplay, fullEdit, editUrl) : '<span class="no-screenshot">—</span>'}</td>
    <td>${screenshotCell}</td>
    <td>${coldMailCell(r)}</td>
  </tr>`;
}

// Statut cold-mail : badge campagne si le salon est déjà parti, sinon "jamais".
// La date n'est affichée que si on la connaît (seul l'export Smartlead daté en
// fournit une) — pas de date inventée pour W3/W6/W6-2.
function coldMailCell(r) {
  if (!r.cold_mail_campaign) return `<span class="cold-mail-never">— ${escapeHtml(t('cell.cold_never'))}</span>`;
  const date = r.cold_mail_sent_at ? ' · ' + escapeHtml(String(r.cold_mail_sent_at).slice(0, 7)) : '';
  return `<span class="cold-mail-badge">${escapeHtml(r.cold_mail_campaign)}${date}</span>`;
}

function bindRowActions() {
  // Selection : checkbox par ligne
  document.querySelectorAll('.row-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const tr = cb.closest('tr');
      const slug = tr.dataset.slug;
      if (cb.checked) {
        state.selectedSlugs.add(slug);
        tr.classList.add('row-selected');
      } else {
        state.selectedSlugs.delete(slug);
        tr.classList.remove('row-selected');
      }
      updateSelectionUI();
    });
  });

  // Click sur une cellule presentation : ouvre la modale
  document.querySelectorAll('.open-presentation').forEach(el => {
    el.addEventListener('click', () => {
      const slug = el.dataset.slug;
      openPresentationModal(slug);
    });
  });

  document.querySelectorAll('.screenshot-thumb').forEach(img => {
    img.addEventListener('click', () => {
      $('modal-image').src = img.dataset.full;
      $('screenshot-modal').hidden = false;
    });
  });

  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const text = btn.dataset.copy;
      navigator.clipboard.writeText(text).then(() => {
        const original = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = original; }, 1200);
      }).catch(() => {
        prompt('Copier ce lien :', text);
      });
    });
  });

  // Edition inline du Nom final
  document.querySelectorAll('.nom-final-input').forEach(input => {
    let saving = false;
    const wrap = input.closest('.nom-final-wrap');
    const status = wrap.querySelector('.nom-final-status');

    const save = async () => {
      if (saving) return;
      const slug = input.dataset.slug;
      const original = input.dataset.original;
      const current = input.value.trim();
      if (current === original) { status.textContent = ''; return; }
      if (!current) {
        status.textContent = t('err.empty_field') + ' ✗';
        status.className = 'nom-final-status error';
        input.value = original;
        return;
      }
      saving = true;
      status.textContent = t('err.saving');
      status.className = 'nom-final-status saving';
      try {
        const res = await fetch(`/admin/salon/${encodeURIComponent(slug)}/nom-final`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ nom_final: current })
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.error || 'Erreur');
        }
        input.dataset.original = current;
        // Vérifier si différent du nom scrappé pour la classe modified
        const tr = input.closest('tr');
        const scrappe = tr.querySelector('.nom-scrappe').textContent;
        wrap.classList.toggle('modified', current !== scrappe);
        status.textContent = '✓';
        status.className = 'nom-final-status saved';
        setTimeout(() => { status.textContent = ''; }, 1500);
      } catch (e) {
        status.textContent = '✗ ' + e.message;
        status.className = 'nom-final-status error';
      } finally {
        saving = false;
      }
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') {
        input.value = input.dataset.original;
        input.blur();
        status.textContent = '';
      }
    });
  });
}

// File picker custom (translatable) — supporte multi-fichiers
const csvFileInput = $('csv-file-input');
const csvFilePickerBtn = $('csv-file-picker-btn');
const csvFilePickerName = $('csv-file-picker-name');
const sourceNameInput = $('source-name-input');
const csvImportHint = $('csv-import-hint');

// Derivation cote client (miroir du backend) : "coiffeur-france-...-cantal.csv" -> "cantal"
function deriveSourceFromFilename(filename) {
  if (!filename) return '';
  const noExt = String(filename).replace(/\.(csv|tsv|txt)$/i, '');
  const parts = noExt.split(/[-_./\\\s]+/).filter(Boolean);
  return parts[parts.length - 1] || noExt || '';
}

function updateFilePickerUI() {
  const files = csvFileInput?.files;
  if (!files || files.length === 0) {
    if (csvFilePickerName) {
      csvFilePickerName.dataset.i18n = 'csv.no_file';
      csvFilePickerName.textContent = t('csv.no_file');
      csvFilePickerName.parentElement.classList.remove('has-file');
    }
    if (sourceNameInput) {
      sourceNameInput.disabled = false;
      sourceNameInput.placeholder = t('csv.source_name_placeholder_optional');
    }
    if (csvImportHint) csvImportHint.innerHTML = t('csv.hint_default');
    return;
  }

  if (files.length === 1) {
    const file = files[0];
    if (csvFilePickerName) {
      csvFilePickerName.removeAttribute('data-i18n');
      csvFilePickerName.textContent = file.name;
      csvFilePickerName.parentElement.classList.add('has-file');
    }
    if (sourceNameInput) {
      sourceNameInput.disabled = false;
      const auto = deriveSourceFromFilename(file.name);
      sourceNameInput.placeholder = t('csv.source_auto_placeholder', { name: auto });
    }
    if (csvImportHint) {
      const auto = deriveSourceFromFilename(file.name);
      csvImportHint.innerHTML = t('csv.hint_single', { name: auto });
    }
  } else {
    // Multi-fichiers : nom auto force, input source desactive
    const names = Array.from(files).map(f => deriveSourceFromFilename(f.name));
    if (csvFilePickerName) {
      csvFilePickerName.removeAttribute('data-i18n');
      csvFilePickerName.textContent = t('csv.files_selected', { count: files.length });
      csvFilePickerName.parentElement.classList.add('has-file');
    }
    if (sourceNameInput) {
      sourceNameInput.value = '';
      sourceNameInput.disabled = true;
      sourceNameInput.placeholder = t('csv.source_auto_multi');
    }
    if (csvImportHint) {
      csvImportHint.innerHTML = t('csv.hint_multi', { count: files.length, names: names.join(', ') });
    }
  }
}

if (csvFilePickerBtn && csvFileInput) {
  csvFilePickerBtn.addEventListener('click', () => csvFileInput.click());
  csvFileInput.addEventListener('change', updateFilePickerUI);
}

async function uploadOneCsv(file, sourceName, groupId) {
  const fd = new FormData();
  fd.append('csv', file);
  if (sourceName) fd.append('source_name', sourceName);
  if (groupId) fd.append('group_id', groupId);
  const res = await fetch('/admin/upload-csv', {
    method: 'POST',
    body: fd,
    credentials: 'same-origin',
    headers: { 'Accept': 'application/json' }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || t('err.generic'));
  return data;
}

$('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const files = Array.from(csvFileInput?.files || []);
  if (!files.length) return;

  const result = $('upload-result');
  result.classList.add('visible');
  result.textContent = t('csv.importing');
  const groupId = ($('upload-group-select')?.value || '') || null;
  const manualSource = (sourceNameInput?.value || '').trim();

  const summary = [];
  try {
    if (files.length === 1) {
      // Source name : manuel si fourni, sinon auto-derive cote backend
      const data = await uploadOneCsv(files[0], manualSource, groupId);
      summary.push(`✓ ${data.source_name}: ${data.imported} importes (${data.skipped} ignores)`);
    } else {
      // Multi : pas de source manuelle, chacun a son nom auto
      for (let i = 0; i < files.length; i++) {
        result.textContent = t('csv.importing_progress', { current: i + 1, total: files.length, name: files[i].name });
        try {
          const data = await uploadOneCsv(files[i], '', groupId);
          summary.push(`✓ ${data.source_name}: ${data.imported} importes (${data.skipped} ignores)`);
        } catch (err) {
          summary.push(`✗ ${files[i].name}: ${err.message}`);
        }
      }
    }
    result.textContent = summary.join('\n');
    e.target.reset();
    updateFilePickerUI();
    await loadGroups();
    await loadStats();
    await loadSalons();
  } catch (err) {
    result.textContent = t('err.generic') + ': ' + err.message;
  }
});

$('search-input').addEventListener('input', debounce(() => {
  state.search = $('search-input').value;
  state.page = 0;
  loadSalons();
}, 250));

$('csv-source-filter').addEventListener('change', () => {
  state.csvSource = $('csv-source-filter').value;
  state.page = 0;
  loadSalons();
});

if ($('contact-status-filter')) $('contact-status-filter').addEventListener('change', () => {
  state.contactStatus = $('contact-status-filter').value;
  state.page = 0;
  loadSalons();
});

$('refresh-btn').addEventListener('click', () => {
  loadStats();
  loadSalons();
});

// Pagination : on délègue à TOUTES les instances .pagination[data-pagination] (haut + bas)
document.querySelectorAll('[data-pagination]').forEach(pg => {
  const prev = pg.querySelector('.pagination-prev');
  const next = pg.querySelector('.pagination-next');
  const sel = pg.querySelector('.page-size-select');
  if (prev) prev.addEventListener('click', () => { state.page = Math.max(0, state.page - 1); loadSalons(); });
  if (next) next.addEventListener('click', () => { state.page++; loadSalons(); });
  if (sel) {
    sel.value = String(state.pageSize);
    sel.addEventListener('change', () => {
      const v = parseInt(sel.value, 10);
      if (!ALLOWED_PAGE_SIZES.includes(v)) return;
      state.pageSize = v;
      localStorage.setItem(PAGE_SIZE_KEY, String(v));
      state.page = 0;
      loadSalons();
    });
  }
});

// Click-to-expand sur une colonne : un seul header expanded à la fois.
// Click sur le header → toggle (re-click = collapse). Click sur une cellule → expand sa colonne.
document.addEventListener('click', (e) => {
  // 1) Click sur un th avec data-col-idx (skip checkbox)
  const th = e.target.closest('.salons-table thead th[data-col-idx]');
  if (th) {
    const idx = parseInt(th.dataset.colIdx, 10);
    if (state.expandedCol === idx) {
      clearExpandedColumn();
    } else {
      applyExpandedColumn(idx);
    }
    return;
  }
  // 2) Click sur une cellule td (sauf checkbox, sauf inputs/buttons interactifs où on ne veut pas hijacker)
  const td = e.target.closest('.salons-table tbody td');
  if (td && !td.classList.contains('col-checkbox')) {
    // Si l'utilisateur clique sur un input, un bouton, un lien, un thumb : ne pas expand
    if (e.target.closest('input, button, a, .screenshot-thumb, .open-presentation, .copy-btn')) return;
    const tr = td.parentElement;
    const allTds = Array.from(tr.children);
    const idx = allTds.indexOf(td);
    if (idx > 0) applyExpandedColumn(idx);
  }
});

$('logout-btn').addEventListener('click', async () => {
  await fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' });
  location.href = '/admin/login';
});

$('modal-close').addEventListener('click', () => { $('screenshot-modal').hidden = true; });
$('screenshot-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('screenshot-modal').hidden = true;
});

// Le handler du bouton "Generer les captures" est maintenant base sur la selection :
// voir runCaptureSelection() plus bas dans la section "SELECTION".

async function pollJob(jobId, expectedTotal) {
  const status = $('job-status');
  const interval = setInterval(async () => {
    try {
      const job = await api(`/admin/job/${jobId}`);
      status.textContent = t('job.status_label', {
        status: job.status,
        done: job.done,
        total: job.total,
        errors: job.errors
      });
      if (job.total > 0) {
        const lastName = job.last && job.last.slug ? job.last.slug : (job.last || '');
        updateProgressBar(job.done, job.total, lastName);
      }
      if (job.status === 'finished' || job.status === 'error') {
        clearInterval(interval);
        if (job.total > 0) updateProgressBar(job.done, job.total, '');
        hideProgressBar();
        await loadSalons();
        await loadStats();
        setTimeout(() => { status.textContent = ''; }, 5000);
      }
    } catch {
      clearInterval(interval);
      hideProgressBar();
    }
  }, 1200);
}

// Le bouton "Exporter CSV enrichi" du bloc Salons a ete supprime — l'export se fait
// maintenant via le composer dans le bloc CSV (modale dediee).

// Le bouton clean-names-btn a ete remplace par la checkbox + bouton Run.
// La fonction runCleanNames legacy reste utilisable manuellement mais n'est plus liee
// a un bouton (l'orchestrateur /run-actions se charge des appels Azure).

async function runCleanNames({ csv_source, force }) {
  const btn = null; // bouton supprime
  try {
    const res = await api('/admin/clean-names', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv_source, group_id: state.groupId || null, force })
    });
    if (res.total === 0) {
      // Tout est deja a jour : proposer de forcer
      const total = parseInt($('stat-total').textContent) || 0;
      const ok = confirm(t('msg.all_clean_already', { total }) + '\n\n' + t('msg.force_clean_question'));
      if (ok) {
        return runCleanNames({ csv_source, force: true });
      }
      return;
    }
    showProgressBar(res.total);
    pollJob(res.jobId, res.total);
  } catch (e) {
    alert(e.message);
  }
}

function showProgressBar(total) {
  let bar = $('clean-progress-bar');
  if (!bar) {
    const html = `
      <div id="clean-progress-bar" class="clean-progress">
        <div class="clean-progress-info">
          <span class="clean-progress-label" id="clean-progress-label">0 / ${total}</span>
          <span class="clean-progress-last" id="clean-progress-last"></span>
        </div>
        <div class="clean-progress-track"><div class="clean-progress-fill" id="clean-progress-fill" style="width: 0%"></div></div>
      </div>`;
    document.querySelector('.batch-actions').insertAdjacentHTML('afterend', html);
  } else {
    $('clean-progress-label').textContent = `0 / ${total}`;
    $('clean-progress-fill').style.width = '0%';
    $('clean-progress-last').textContent = '';
    bar.style.display = '';
  }
}

function updateProgressBar(done, total, last) {
  const fill = $('clean-progress-fill');
  const label = $('clean-progress-label');
  const lastEl = $('clean-progress-last');
  if (!fill) return;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  fill.style.width = pct + '%';
  if (label) label.textContent = `${done} / ${total} (${pct}%)`;
  if (lastEl && last) lastEl.textContent = String(last).slice(0, 60);
}

function hideProgressBar() {
  const bar = $('clean-progress-bar');
  if (bar) setTimeout(() => bar.remove(), 2500);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ==============================
// GROUPES
// ==============================
async function loadGroups() {
  const data = await api('/admin/groups');
  state.groups = data.groups || [];
  state.orphanCount = data.orphan_count || 0;
  renderGroupsSelect();
  renderUploadGroupSelect();
  updateGroupActions();
  renderGroupInfo();
}

function renderGroupsSelect() {
  const sel = $('active-group-select');
  if (!sel) return;
  const total = state.groups.reduce((sum, g) => sum + g.salons_count, 0) + state.orphanCount;
  const opts = [
    `<option value="">${escapeHtml(t('groups.all_salons'))} (${total})</option>`
  ];
  if (state.orphanCount > 0) {
    opts.push(`<option value="none">${escapeHtml(t('groups.without_group'))} (${state.orphanCount})</option>`);
  }
  for (const g of state.groups) {
    opts.push(`<option value="${g.id}">${escapeHtml(g.name)} (${g.salons_count})</option>`);
  }
  sel.innerHTML = opts.join('');
  sel.value = state.groupId || '';
}

function renderUploadGroupSelect() {
  const sel = $('upload-group-select');
  if (!sel) return;
  const opts = [
    `<option value="">${escapeHtml(t('groups.import_no_group'))}</option>`
  ];
  for (const g of state.groups) {
    opts.push(`<option value="${g.id}">${escapeHtml(g.name)}</option>`);
  }
  sel.innerHTML = opts.join('');
  // Pre-selectionner le groupe actif si on en a un
  if (state.groupId && state.groupId !== 'none') sel.value = state.groupId;
}

function updateGroupActions() {
  const isSpecificGroup = state.groupId && state.groupId !== 'none';
  $('btn-rename-group').disabled = !isSpecificGroup;
  $('btn-delete-group').disabled = !isSpecificGroup;
}

function renderGroupInfo() {
  const info = $('groups-info');
  if (!info) return;
  if (!state.groupId) { info.classList.remove('visible'); info.innerHTML = ''; return; }
  if (state.groupId === 'none') {
    info.innerHTML = `<strong>${escapeHtml(t('groups.without_group'))}</strong> — ${escapeHtml(t('groups.orphan_help'))}`;
    info.classList.add('visible');
    return;
  }
  const g = state.groups.find(x => String(x.id) === String(state.groupId));
  if (!g) { info.classList.remove('visible'); return; }
  const desc = g.description ? ` · ${escapeHtml(g.description)}` : '';
  info.innerHTML = `<strong>${escapeHtml(g.name)}</strong> — ${g.salons_count} ${escapeHtml(t('groups.salons_label'))}, ${g.csv_sources_count} ${escapeHtml(t('groups.sources_label'))}${desc}`;
  info.classList.add('visible');
}

$('active-group-select').addEventListener('change', () => {
  state.groupId = $('active-group-select').value;
  if (state.groupId) localStorage.setItem(ACTIVE_GROUP_KEY, state.groupId);
  else localStorage.removeItem(ACTIVE_GROUP_KEY);
  state.page = 0;
  state.csvSource = '';
  $('csv-source-filter').value = '';
  updateGroupActions();
  renderGroupInfo();
  renderUploadGroupSelect();
  loadStats();
  loadSalons();
});

$('btn-new-group').addEventListener('click', async () => {
  const name = prompt(t('groups.prompt_new_name'));
  if (!name || !name.trim()) return;
  const description = prompt(t('groups.prompt_new_description')) || '';
  try {
    const res = await api('/admin/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), description: description.trim() })
    });
    await loadGroups();
    state.groupId = String(res.id);
    localStorage.setItem(ACTIVE_GROUP_KEY, state.groupId);
    $('active-group-select').value = state.groupId;
    $('active-group-select').dispatchEvent(new Event('change'));
  } catch (e) { alert(e.message); }
});

$('btn-rename-group').addEventListener('click', async () => {
  const g = state.groups.find(x => String(x.id) === String(state.groupId));
  if (!g) return;
  const name = prompt(t('groups.prompt_rename'), g.name);
  if (!name || !name.trim() || name.trim() === g.name) return;
  try {
    await api('/admin/groups/' + g.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), description: g.description || '' })
    });
    await loadGroups();
    renderGroupInfo();
  } catch (e) { alert(e.message); }
});

$('btn-delete-group').addEventListener('click', async () => {
  const g = state.groups.find(x => String(x.id) === String(state.groupId));
  if (!g) return;
  const ok = confirm(t('groups.confirm_delete', { name: g.name, count: g.salons_count }));
  if (!ok) return;
  try {
    await api('/admin/groups/' + g.id, { method: 'DELETE' });
    state.groupId = '';
    localStorage.removeItem(ACTIVE_GROUP_KEY);
    await loadGroups();
    await loadStats();
    await loadSalons();
  } catch (e) { alert(e.message); }
});

// ==============================
// SELECTION (cases a cocher) + actions sur la selection
// ==============================
function updateBulkActionsBar() {
  // Compatibilite : cette fonction etait appelee dans loadSalons, on garde son nom
  // mais elle gere maintenant la selection.
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = state.selectedSlugs.size;
  const info = $('selection-info');
  const span = info?.querySelector('span');

  if (count === 0) {
    if (info) info.hidden = true;
  } else {
    if (info) {
      info.hidden = false;
      if (span) span.innerHTML = t('table.selection_count', { count });
    }
  }

  // Boutons qui dependent de la selection
  const deleteBtn = $('bulk-delete-selection-btn');
  if (deleteBtn) deleteBtn.disabled = count === 0;
  updateRunButtonState();

  // Master checkbox : etat (checked / unchecked / indeterminate)
  const master = $('select-all-checkbox');
  let allVisibleSelected = false;
  let visibleSlugs = [];
  if (master) {
    visibleSlugs = Array.from(document.querySelectorAll('.row-checkbox')).map(cb => cb.closest('tr').dataset.slug);
    if (visibleSlugs.length === 0) {
      master.checked = false;
      master.indeterminate = false;
    } else {
      allVisibleSelected = visibleSlugs.every(s => state.selectedSlugs.has(s));
      const noneSelected = visibleSlugs.every(s => !state.selectedSlugs.has(s));
      master.checked = allVisibleSelected;
      master.indeterminate = !allVisibleSelected && !noneSelected;
    }
  }

  updateCrossPagesBanner({ visibleSlugs, allVisibleSelected });
}

// =====================================================================
// Bandeau "selectionner toutes les pages" (style Gmail)
// =====================================================================
function updateCrossPagesBanner({ visibleSlugs, allVisibleSelected }) {
  const banner = $('cross-pages-banner');
  if (!banner) return;
  const text = $('cross-pages-text');
  const action = $('cross-pages-action');
  if (!text || !action) return;

  const total = state.total || 0;
  const visibleCount = visibleSlugs.length;
  const moreThanCurrentPage = total > visibleCount;

  // Pas de page courante affichee : on cache.
  // Toute la page n'est pas selectionnee : on cache.
  // Pas plus de salons que la page courante : on cache.
  if (visibleCount === 0 || !allVisibleSelected || !moreThanCurrentPage) {
    banner.hidden = true;
    return;
  }

  // Cas 1 : tous les salons (sur toutes les pages) sont selectionnes -> proposer d'annuler
  if (state.selectedSlugs.size >= total) {
    text.innerHTML = t('table.cross_pages_all_selected', { total });
    action.textContent = t('table.cross_pages_clear');
    action.dataset.mode = 'clear';
  } else {
    // Cas 2 : seules les lignes de la page courante sont selectionnees -> proposer de tout cocher
    text.innerHTML = t('table.cross_pages_prompt', { count: visibleCount });
    action.innerHTML = t('table.cross_pages_action', { total });
    action.dataset.mode = 'select-all';
  }
  banner.hidden = false;
}

async function selectAllAcrossPages() {
  const action = $('cross-pages-action');
  if (!action) return;
  const oldHtml = action.innerHTML;
  action.disabled = true;
  action.textContent = '…';
  try {
    const params = new URLSearchParams();
    if (state.search) params.set('search', state.search);
    if (state.csvSource) params.set('csv_source', state.csvSource);
    if (state.groupId) params.set('group_id', state.groupId);
    const data = await api('/admin/salon-slugs?' + params.toString());
    if (Array.isArray(data.slugs)) {
      for (const s of data.slugs) state.selectedSlugs.add(s);
    }
    // Re-cocher toutes les checkboxes visibles
    document.querySelectorAll('.row-checkbox').forEach(cb => {
      const tr = cb.closest('tr');
      const slug = tr.dataset.slug;
      if (state.selectedSlugs.has(slug)) {
        cb.checked = true;
        tr.classList.add('row-selected');
      }
    });
    updateSelectionUI();
  } catch (e) {
    action.innerHTML = oldHtml;
    alert(t('err.generic') + ': ' + e.message);
  } finally {
    action.disabled = false;
  }
}

if ($('cross-pages-action')) {
  $('cross-pages-action').addEventListener('click', () => {
    const mode = $('cross-pages-action').dataset.mode;
    if (mode === 'clear') {
      clearSelection();
    } else {
      selectAllAcrossPages();
    }
  });
}

function clearSelection() {
  state.selectedSlugs.clear();
  document.querySelectorAll('.row-checkbox').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('tr.row-selected').forEach(tr => tr.classList.remove('row-selected'));
  updateSelectionUI();
}

// Master checkbox
if ($('select-all-checkbox')) {
  $('select-all-checkbox').addEventListener('change', (e) => {
    const checked = e.target.checked;
    document.querySelectorAll('.row-checkbox').forEach(cb => {
      const slug = cb.closest('tr').dataset.slug;
      cb.checked = checked;
      if (checked) {
        state.selectedSlugs.add(slug);
        cb.closest('tr').classList.add('row-selected');
      } else {
        state.selectedSlugs.delete(slug);
        cb.closest('tr').classList.remove('row-selected');
      }
    });
    updateSelectionUI();
  });
}

if ($('clear-selection-btn')) {
  $('clear-selection-btn').addEventListener('click', clearSelection);
}

// Etat des cases a cocher d'actions (capture, clean_names, correct_presentation)
function getCheckedActions() {
  const actions = {};
  document.querySelectorAll('.action-checkbox input[type="checkbox"]').forEach(cb => {
    actions[cb.dataset.action] = cb.checked;
  });
  return actions;
}

function anyActionChecked() {
  return Object.values(getCheckedActions()).some(Boolean);
}

function updateRunButtonState() {
  const btn = $('run-actions-btn');
  if (!btn) return;
  btn.disabled = state.selectedSlugs.size === 0 || !anyActionChecked();
}

document.querySelectorAll('.action-checkbox input[type="checkbox"]').forEach(cb => {
  cb.addEventListener('change', updateRunButtonState);
});

// Action: Run les actions cochees sur la selection
async function runActions() {
  const slugs = Array.from(state.selectedSlugs);
  if (slugs.length === 0) return;
  const actions = getCheckedActions();
  const enabled = Object.entries(actions).filter(([_, v]) => v).map(([k]) => k);
  if (enabled.length === 0) return;

  // Construire le message de confirmation
  const labelsByKey = {
    capture: t('table.batch_screenshots'),
    clean_names: t('table.clean_names'),
    correct_presentation: t('table.correct_presentation'),
    domain_suggestions: t('table.domain_suggestions')
  };
  const labels = enabled.map(k => labelsByKey[k]).join(', ');
  if (!confirm(t('run.confirm', { count: slugs.length, actions: labels }))) return;

  try {
    const res = await api('/admin/run-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slugs, actions })
    });
    showProgressBar(res.total);
    pollRunJob(res.jobId, res.total);
  } catch (e) {
    alert(t('err.generic') + ': ' + e.message);
  }
}

async function pollRunJob(jobId, expectedTotal) {
  const status = $('job-status');
  const interval = setInterval(async () => {
    try {
      const job = await api(`/admin/run-job/${jobId}`);
      const phase = job.phase ? ` [${job.phase}]` : '';
      status.textContent = t('job.status_label', {
        status: job.status + phase,
        done: job.done,
        total: job.total,
        errors: job.errors
      });
      if (job.total > 0) {
        updateProgressBar(job.done, job.total, job.last || '');
      }
      if (job.status === 'finished' || job.status === 'error') {
        clearInterval(interval);
        if (job.total > 0) updateProgressBar(job.done, job.total, '');
        hideProgressBar();
        await loadSalons();
        await loadStats();
        setTimeout(() => { status.textContent = ''; }, 5000);
      }
    } catch {
      clearInterval(interval);
      hideProgressBar();
    }
  }, 1000);
}

// Action: Supprimer la selection
async function runDeleteSelection() {
  const slugs = Array.from(state.selectedSlugs);
  if (slugs.length === 0) return;
  if (!confirm(t('confirm.delete_selection_1', { count: slugs.length }))) return;
  if (!confirm(t('confirm.delete_selection_2'))) return;
  try {
    const res = await api('/admin/salons/bulk', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, slugs })
    });
    clearSelection();
    await loadGroups();
    await loadStats();
    await loadSalons();
    alert(t('bulk.deleted_success', { count: res.deleted }));
  } catch (e) {
    alert(t('err.generic') + ': ' + e.message);
  }
}

if ($('run-actions-btn')) $('run-actions-btn').addEventListener('click', runActions);
if ($('bulk-delete-selection-btn')) $('bulk-delete-selection-btn').addEventListener('click', runDeleteSelection);

// =====================================================================
// COMPOSER D'EXPORT CSV : modale avec tree groupes + sources cochables
// =====================================================================
let exportTreeData = null;
const exportSelection = new Set(); // set de csv_source noms coches

async function openExportModal() {
  const modal = $('export-modal');
  modal.hidden = false;
  // Charger les donnees fraiches a chaque ouverture
  try {
    exportTreeData = await api('/admin/export-tree');
    // Par defaut : tout cocher
    exportSelection.clear();
    for (const g of exportTreeData.groups) {
      for (const s of g.sources) exportSelection.add(s.name);
    }
    for (const s of exportTreeData.orphan.sources) exportSelection.add(s.name);
    renderExportTree();
    updateExportSummary();
  } catch (e) {
    alert(t('err.generic') + ': ' + e.message);
    modal.hidden = true;
  }
}

function renderExportTree() {
  const container = $('export-tree');
  if (!container || !exportTreeData) return;

  const html = [];

  for (const g of exportTreeData.groups) {
    if (g.sources.length === 0 && g.salons_count === 0) continue;
    html.push(buildGroupNode(g.name, g.sources, `g-${g.id}`));
  }

  if (exportTreeData.orphan.count > 0 && exportTreeData.orphan.sources.length > 0) {
    html.push(buildGroupNode(t('groups.without_group'), exportTreeData.orphan.sources, 'g-orphan'));
  }

  container.innerHTML = html.length ? html.join('') : `<div class="export-empty">${escapeHtml(t('export.empty'))}</div>`;

  // Bind events
  container.querySelectorAll('.export-group-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const node = cb.closest('.export-group-node');
      const sources = node.querySelectorAll('.export-source-checkbox');
      sources.forEach(s => {
        s.checked = cb.checked;
        toggleSource(s.value, cb.checked);
      });
      updateExportSummary();
    });
  });
  container.querySelectorAll('.export-source-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      toggleSource(cb.value, cb.checked);
      updateGroupCheckboxState(cb.closest('.export-group-node'));
      updateExportSummary();
    });
  });

  // Initialiser l'etat des checkboxes
  container.querySelectorAll('.export-source-checkbox').forEach(cb => {
    cb.checked = exportSelection.has(cb.value);
  });
  container.querySelectorAll('.export-group-node').forEach(n => updateGroupCheckboxState(n));
}

function buildGroupNode(groupName, sources, idPrefix) {
  const total = sources.reduce((s, x) => s + x.count, 0);
  return `
    <div class="export-group-node" data-id="${escapeAttr(idPrefix)}">
      <label class="export-group-row">
        <input type="checkbox" class="export-group-checkbox" id="${idPrefix}">
        <span class="export-group-name">${escapeHtml(groupName)}</span>
        <span class="export-group-count">${total} ${escapeHtml(t('groups.salons_label'))}</span>
      </label>
      <div class="export-source-list">
        ${sources.map(s => `
          <label class="export-source-row">
            <input type="checkbox" class="export-source-checkbox" value="${escapeAttr(s.name)}">
            <span class="export-source-name">${escapeHtml(s.name)}</span>
            <span class="export-source-count">${s.count}</span>
          </label>
        `).join('')}
      </div>
    </div>
  `;
}

function toggleSource(name, checked) {
  if (checked) exportSelection.add(name);
  else exportSelection.delete(name);
}

function updateGroupCheckboxState(node) {
  const cb = node.querySelector('.export-group-checkbox');
  const sources = node.querySelectorAll('.export-source-checkbox');
  if (sources.length === 0) return;
  const checked = Array.from(sources).filter(s => s.checked).length;
  if (checked === 0) { cb.checked = false; cb.indeterminate = false; }
  else if (checked === sources.length) { cb.checked = true; cb.indeterminate = false; }
  else { cb.checked = false; cb.indeterminate = true; }
}

function updateExportSummary() {
  const count = computeSelectionCount();
  const el = $('export-count');
  if (el) el.innerHTML = t('export.count_label', { count });
  $('export-confirm').disabled = count === 0;
}

function computeSelectionCount() {
  if (!exportTreeData) return 0;
  let total = 0;
  for (const g of exportTreeData.groups) {
    for (const s of g.sources) {
      if (exportSelection.has(s.name)) total += s.count;
    }
  }
  for (const s of exportTreeData.orphan.sources) {
    if (exportSelection.has(s.name)) total += s.count;
  }
  return total;
}

function selectAllSources(checked) {
  if (!exportTreeData) return;
  exportSelection.clear();
  if (checked) {
    for (const g of exportTreeData.groups) for (const s of g.sources) exportSelection.add(s.name);
    for (const s of exportTreeData.orphan.sources) exportSelection.add(s.name);
  }
  // Update DOM
  document.querySelectorAll('.export-source-checkbox').forEach(cb => { cb.checked = checked; });
  document.querySelectorAll('.export-group-node').forEach(n => updateGroupCheckboxState(n));
  updateExportSummary();
}

function doExport() {
  if (exportSelection.size === 0) return;
  const format = (document.querySelector('input[name="export-format"]:checked') || {}).value || 'smartlead';
  const sources = Array.from(exportSelection).sort();
  const params = new URLSearchParams();
  params.set('format', format);
  params.set('csv_sources', sources.join(','));
  const domain = $('export-domain') ? $('export-domain').value : '';
  if (domain) params.set('email_domain', domain);
  const limit = $('export-limit') ? parseInt($('export-limit').value, 10) : NaN;
  if (Number.isFinite(limit) && limit > 0) params.set('limit', String(limit));
  if ($('export-exclude-contacted') && $('export-exclude-contacted').checked) params.set('exclude_contacted', '1');
  // Naviguer pour declencher le download (l'endpoint est sur /admin avec session cookie)
  location.href = '/admin/export-csv?' + params.toString();
}

if ($('open-export-composer-btn')) $('open-export-composer-btn').addEventListener('click', openExportModal);
if ($('export-modal-close')) $('export-modal-close').addEventListener('click', () => { $('export-modal').hidden = true; });
if ($('export-cancel')) $('export-cancel').addEventListener('click', () => { $('export-modal').hidden = true; });
if ($('export-modal')) {
  $('export-modal').addEventListener('click', (e) => {
    if (e.target === $('export-modal')) $('export-modal').hidden = true;
  });
}
if ($('export-select-all')) $('export-select-all').addEventListener('click', () => selectAllSources(true));
if ($('export-deselect-all')) $('export-deselect-all').addEventListener('click', () => selectAllSources(false));
if ($('export-confirm')) $('export-confirm').addEventListener('click', doExport);

// =================================================================
// MODALE PRESENTATION : afficher + editer la presentation corrigee
// =================================================================
let currentPresentationSlug = null;

async function openPresentationModal(slug) {
  currentPresentationSlug = slug;
  const modal = $('presentation-modal');
  const status = $('presentation-modal-status');
  status.textContent = '';

  // Recuperer les donnees a jour
  try {
    const data = await api(`/api/salons?limit=1&search=${encodeURIComponent(slug)}`);
    const row = (data.rows || []).find(r => r.slug === slug);
    if (!row) throw new Error('Salon introuvable');

    $('presentation-modal-title').textContent = row.nom_clean || row.nom;
    $('presentation-modal-scrappee').textContent = row.presentation_scrappee || '(vide — pas de meta description dans le CSV)';
    $('presentation-modal-corrigee').value = row.presentation_corrigee || '';
    modal.hidden = false;
  } catch (e) {
    alert(t('err.generic') + ': ' + e.message);
  }
}

async function savePresentationModal() {
  if (!currentPresentationSlug) return;
  const value = $('presentation-modal-corrigee').value.trim();
  const status = $('presentation-modal-status');
  status.textContent = '…';
  status.className = 'modal-presentation-status saving';
  try {
    await api(`/admin/salon/${encodeURIComponent(currentPresentationSlug)}/presentation`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presentation: value })
    });
    status.textContent = '✓ ' + t('modal.saved');
    status.className = 'modal-presentation-status saved';
    await loadSalons();
    setTimeout(() => { $('presentation-modal').hidden = true; }, 800);
  } catch (e) {
    status.textContent = '✗ ' + e.message;
    status.className = 'modal-presentation-status error';
  }
}

if ($('presentation-modal-close')) {
  $('presentation-modal-close').addEventListener('click', () => { $('presentation-modal').hidden = true; });
}
if ($('presentation-modal-save')) {
  $('presentation-modal-save').addEventListener('click', savePresentationModal);
}
if ($('presentation-modal-reset')) {
  $('presentation-modal-reset').addEventListener('click', () => {
    $('presentation-modal-corrigee').value = '';
  });
}
if ($('presentation-modal')) {
  $('presentation-modal').addEventListener('click', (e) => {
    if (e.target === $('presentation-modal')) $('presentation-modal').hidden = true;
  });
}

// Language switcher : applique la langue au chargement. Le CLIC sur FR/EN/中 est
// géré par admin-nav.js (partagé sur toutes les pages : set localStorage + reload).
applyTranslations();
// Re-render dynamic content (table + select) when language changes
window.onLangChange = () => {
  loadGroups();
  loadStats();
  loadSalons();
};

(async () => {
  try {
    await refreshAuth();
    await loadGroups();
    await loadStats();
    await loadSalons();
  } catch (e) {
    console.error(e);
  }
})();
