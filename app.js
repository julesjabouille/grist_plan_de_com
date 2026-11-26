/*
 * Widget Grist « Plan de communication »
 *
 * Calendrier 2 mois / 2 mois (inspiré Excel PLAN COM), DSFR.
 *
 * Table hôte — une ligne = un événement (ou une absence si agent seul) :
 *   date, categorie, evenement, note, lien, vues, likes
 *   (+ agent optionnel pour les absences)
 *
 * Tables liées :
 *   - REF_categories_com.intitule → catégories de com
 *   - suivi_projets.Titre → sélecteur d’événements
 *   - agents (case com) → absents / couleurs
 */

const COLONNES = [
  { name: 'date', title: 'Date', type: 'Date' },
  { name: 'categorie', title: 'Catégorie', type: 'Any', optional: true },
  { name: 'evenement', title: 'Événement (suivi_projets)', type: 'Any', optional: true },
  { name: 'note', title: 'Note', type: 'Text', optional: true },
  { name: 'lien', title: 'Lien', type: 'Text', optional: true },
  { name: 'vues', title: 'Vues', type: 'Any', optional: true },
  { name: 'likes', title: 'Likes', type: 'Any', optional: true },
  { name: 'agent', title: 'Agent absent', type: 'Any', optional: true },
];

const PALETTE = [
  '#0066ff', '#6a00f5', '#e4794a', '#00a95f', '#C8102E',
  '#0077C8', '#FFC000', '#7030A0', '#5B9BD5', '#70AD47',
];

const MOIS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

// ---------------------------------------------------------------------------
// Fériés
// ---------------------------------------------------------------------------

function paques(annee) {
  const a = annee % 19;
  const b = Math.floor(annee / 100);
  const c = annee % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mois = Math.floor((h + l - 7 * m + 114) / 31);
  const jour = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(annee, mois - 1, jour));
}

function ajouterJours(date, n) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function joursFeries(annee) {
  const p = paques(annee);
  const fixes = [
    [1, 1], [5, 1], [5, 8], [7, 14], [8, 15], [11, 1], [11, 11], [12, 25],
  ].map(([m, j]) => isoUTC(annee, m - 1, j));
  const mobiles = [p, ajouterJours(p, 1), ajouterJours(p, 39), ajouterJours(p, 50)].map(isoDepuisDate);
  return new Set([...fixes, ...mobiles]);
}

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

let enregistrements = [];
let mappingsGrist = {};
let categories = [];         // { id, libelle, court, couleur }
let agentsCom = [];
let evenementsProjets = [];
let debutBimestre = null;
let jourActif = null;        // iso ouvert dans la modale
let brouillon = null;        // { iso, evenements[], absents:Set, originIds:Set, tempId }
let editionId = null;        // id de la ligne en cours d’édition dans le brouillon
let enEcriture = false;
let modeDemo = false;
let feriesCache = new Map();
let jetonLiees = 0;
let sequencesSansDate = '';
let sequencesModifiees = false;
let sequencesStatut = '';

// ---------------------------------------------------------------------------
// Aides
// ---------------------------------------------------------------------------

const $ = (s) => document.querySelector(s);

function h(balise, props = {}, ...enfants) {
  const el = document.createElement(balise);
  for (const [cle, valeur] of Object.entries(props)) {
    if (valeur === undefined || valeur === null || valeur === false) continue;
    if (cle === 'class') el.className = valeur;
    else if (cle === 'style' && typeof valeur === 'object') Object.assign(el.style, valeur);
    else if (cle.startsWith('on') && typeof valeur === 'function') el.addEventListener(cle.slice(2), valeur);
    else if (cle in el && !cle.includes('-') && cle !== 'role') el[cle] = valeur;
    else el.setAttribute(cle, valeur === true ? '' : valeur);
  }
  el.append(...enfants.flat().filter((e) => e !== null && e !== undefined && e !== false));
  return el;
}

function dechiffrer(valeur) {
  if (!Array.isArray(valeur)) return valeur;
  const [type] = valeur;
  if (type === 'L' || type === 'l') return valeur.slice(1);
  if (type === 'r') return Array.isArray(valeur[2]) ? valeur[2] : [];
  if (type === 'R') return valeur[2];
  if (type === 'd' || type === 'D') return valeur[1];
  return valeur;
}

function texte(valeur) {
  const x = dechiffrer(valeur);
  if (x === null || x === undefined) return '';
  if (Array.isArray(x)) return x.join(', ');
  return String(x);
}

function idRef(valeur) {
  const x = dechiffrer(valeur);
  return typeof x === 'number' ? x : 0;
}

function nombre(valeur) {
  const x = dechiffrer(valeur);
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function versColonnes(donneesBrutes) {
  if (!Array.isArray(donneesBrutes)) return donneesBrutes || {};
  const colonnes = {};
  for (const ligne of donneesBrutes) {
    for (const [cle, valeur] of Object.entries(ligne)) (colonnes[cle] ||= []).push(valeur);
  }
  return colonnes;
}

function versDate(valeur) {
  const x = dechiffrer(valeur);
  if (x === null || x === undefined || x === '') return null;
  if (typeof x === 'number') return new Date(x * 1000);
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x)) return new Date(`${x.slice(0, 10)}T00:00:00Z`);
  const d = new Date(x);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDepuisDate(d) {
  if (!d) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const j = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${j}`;
}

function isoUTC(annee, mois0, jour) {
  return isoDepuisDate(new Date(Date.UTC(annee, mois0, jour)));
}

function ajouterMois(d, n) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function joursDansMois(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

function libelleMois(d) {
  return `${MOIS_FR[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function aujourdhuiIso() {
  const n = new Date();
  return isoUTC(n.getFullYear(), n.getMonth(), n.getDate());
}

function estWeekend(iso) {
  const j = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return j === 0 || j === 6;
}

function estFerie(iso) {
  const annee = Number(iso.slice(0, 4));
  if (!feriesCache.has(annee)) feriesCache.set(annee, joursFeries(annee));
  return feriesCache.get(annee).has(iso);
}

function initiales(nom) {
  const parts = String(nom || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function couleurDepuis(id, couleurBrute, index) {
  const c = texte(couleurBrute).trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(c)) return c.startsWith('#') ? c : `#${c}`;
  if (/^#?[0-9a-fA-F]{3}$/.test(c)) {
    const hex = c.replace('#', '');
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  }
  return PALETTE[Math.abs(Number(id) || index) % PALETTE.length];
}

function contrasteTexte(hex) {
  const h6 = hex.replace('#', '');
  const r = parseInt(h6.slice(0, 2), 16);
  const g = parseInt(h6.slice(2, 4), 16);
  const b = parseInt(h6.slice(4, 6), 16);
  return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) > 0.62 ? '#161616' : '#ffffff';
}

function afficherErreur(message) {
  const el = $('#message-erreur');
  el.querySelector('p').textContent = message;
  el.hidden = !message;
}

function normaliserUrl(url) {
  const t = String(url || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

function tronquer(s, n = 28) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ---------------------------------------------------------------------------
// Catégories
// ---------------------------------------------------------------------------

function categorieFallback() {
  return [
    { id: 1, libelle: 'Presse / Événementiel / Intervention', court: 'Presse / Event', couleur: PALETTE[0] },
    { id: 2, libelle: 'Réseaux sociaux', court: 'Réseaux sociaux', couleur: PALETTE[1] },
    { id: 3, libelle: 'Séquences gouv. / ministérielles / tutelles', court: 'Gouv. / Tutelles', couleur: PALETTE[2] },
    { id: 4, libelle: 'Action de com interne', court: 'Com interne', couleur: PALETTE[3] },
  ];
}

function infoCategorie(refOuLibelle) {
  if (refOuLibelle === null || refOuLibelle === undefined || refOuLibelle === '') return null;
  if (typeof refOuLibelle === 'number') {
    return categories.find((c) => c.id === refOuLibelle) || null;
  }
  const t = String(refOuLibelle).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return categories.find((c) => {
    const l = c.libelle.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return String(c.id) === String(refOuLibelle) || l === t || l.includes(t) || t.includes(l);
  }) || null;
}

function resoudreCategorie(valeur) {
  const id = idRef(valeur);
  if (id) return infoCategorie(id);
  const lib = texte(valeur).trim();
  return lib ? infoCategorie(lib) : null;
}

function estMappe(cle) {
  return Boolean(mappingsGrist && mappingsGrist[cle]);
}

function categorieEstTexte() {
  const sample = enregistrements.find((r) => {
    const v = r.categorie;
    return v !== undefined && v !== null && v !== '' && v !== 0;
  });
  if (!sample) return false;
  const x = dechiffrer(sample.categorie);
  // Ref encodée ['R', table, id] ou nombre → pas du texte.
  if (Array.isArray(x) || typeof x === 'number') return false;
  return typeof x === 'string';
}

function valeurCategoriePourEcriture(catId) {
  const id = Number(catId) || 0;
  if (!id) return categorieEstTexte() ? '' : 0;
  const cat = infoCategorie(id);
  if (!cat) return categorieEstTexte() ? String(id) : id;
  if (modeDemo) return id;
  return categorieEstTexte() ? cat.libelle : id;
}

// ---------------------------------------------------------------------------
// Lecture tables liées
// ---------------------------------------------------------------------------

async function listerTables() {
  const tables = versColonnes(await grist.docApi.fetchTable('_grist_Tables'));
  return (tables.tableId || []).filter((t) => t && !t.startsWith('_grist'));
}

function choisirTable(ids, candidats) {
  const lower = ids.map((t) => [t, t.toLowerCase()]);
  for (const c of candidats) {
    const hit = lower.find(([, l]) => l === c.toLowerCase());
    if (hit) return hit[0];
  }
  for (const c of candidats) {
    const hit = lower.find(([, l]) => l.includes(c.toLowerCase()));
    if (hit) return hit[0];
  }
  return null;
}

function colonneParmi(table, noms) {
  const cles = Object.keys(table || {});
  for (const nom of noms) {
    const hit = cles.find((c) => c.toLowerCase() === nom.toLowerCase());
    if (hit) return hit;
  }
  for (const nom of noms) {
    const hit = cles.find((c) => c.toLowerCase().includes(nom.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

function estVrai(valeur) {
  const x = dechiffrer(valeur);
  if (x === true || x === 1 || x === '1') return true;
  if (typeof x === 'string') {
    const t = x.trim().toLowerCase();
    return t === 'true' || t === 'oui' || t === 'x' || t === 'yes';
  }
  return false;
}

function dedupeParId(liste) {
  const map = new Map();
  for (const item of liste) {
    if (item && item.id != null && !map.has(item.id)) map.set(item.id, item);
  }
  return [...map.values()];
}

async function lireCategories() {
  if (modeDemo) return categorieFallback();
  try {
    const ids = await listerTables();
    const tableId = choisirTable(ids, [
      'REF_categories_com', 'Ref_categories_com', 'Categories_com', 'categories_com',
    ]);
    if (!tableId) {
      afficherErreur('Table « REF_categories_com » introuvable — catégories par défaut utilisées.');
      return categorieFallback();
    }
    const table = versColonnes(await grist.docApi.fetchTable(tableId));
    const col = colonneParmi(table, ['intitule', 'Intitule', 'Intitulé', 'titre', 'Titre', 'libelle', 'Libelle']);
    const colCouleur = colonneParmi(table, ['Couleur', 'couleur', 'Color']);
    const liste = [];
    (table.id || []).forEach((id, i) => {
      const libelle = col ? texte(table[col][i]).trim() : '';
      if (!libelle) return;
      liste.push({
        id,
        libelle,
        court: tronquer(libelle, 22),
        couleur: couleurDepuis(id, colCouleur ? table[colCouleur][i] : '', i),
      });
    });
    return liste.length ? dedupeParId(liste) : categorieFallback();
  } catch (err) {
    console.error(err);
    afficherErreur(`Impossible de lire REF_categories_com : ${err.message || err}`);
    return categorieFallback();
  }
}

async function lireAgents() {
  if (modeDemo) {
    return [
      { id: 1, nom: 'Alice Martin', initiales: 'AM', couleur: '#00B050' },
      { id: 2, nom: 'Bruno Lefèvre', initiales: 'BL', couleur: '#FFC000' },
      { id: 3, nom: 'Chloé Dupont', initiales: 'CD', couleur: '#ED7D31' },
    ];
  }
  try {
    const ids = await listerTables();
    // Correspondance exacte d’abord — éviter « agents_ariane » etc.
    const tableId = choisirTable(ids, ['agents', 'Agents'])
      || choisirTable(ids, ['agent', 'Agent']);
    if (!tableId) {
      afficherErreur('Table « agents » introuvable dans le document.');
      return [];
    }
    const table = versColonnes(await grist.docApi.fetchTable(tableId));
    const colNom = colonneParmi(table, ['Nom', 'nom', 'Name', 'Prenom_Nom', 'Libelle', 'libelle']);
    const colPrenom = colonneParmi(table, ['Prenom', 'Prénom', 'prenom']);
    // Exact « com » seulement (pas « commentaire », « competence »…).
    const colCom = Object.keys(table).find((c) => ['com', 'Com', 'COM'].includes(c))
      || colonneParmi(table, ['equipe_com', 'plan_com']);
    const colCouleur = colonneParmi(table, ['Couleur', 'couleur', 'Color', 'color', 'code_couleur']);
    const colInit = colonneParmi(table, ['Initiales', 'initiales', 'Initial', 'Sigle', 'sigle']);

    const liste = [];
    (table.id || []).forEach((id, i) => {
      if (colCom && !estVrai(table[colCom][i])) return;
      let nom = colNom ? texte(table[colNom][i]) : '';
      if (colPrenom) {
        const p = texte(table[colPrenom][i]);
        nom = [p, nom].filter(Boolean).join(' ').trim() || nom;
      }
      if (!nom) nom = `Agent #${id}`;
      const init = colInit ? texte(table[colInit][i]).trim() : '';
      liste.push({
        id,
        nom,
        initiales: init || initiales(nom),
        couleur: couleurDepuis(id, colCouleur ? table[colCouleur][i] : '', i),
      });
    });
    return dedupeParId(liste).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  } catch (err) {
    console.error(err);
    afficherErreur(`Impossible de lire la table agents : ${err.message || err}`);
    return [];
  }
}

async function lireEvenements() {
  if (modeDemo) {
    return [
      { id: 1, titre: 'Atelier démo Alpha' },
      { id: 2, titre: 'Conférence factice Beta' },
      { id: 3, titre: 'Webinaire Gamma' },
      { id: 4, titre: 'Salon fictif Delta' },
      { id: 5, titre: 'Journée test Epsilon' },
      { id: 6, titre: 'Rencontre Omega' },
    ];
  }
  try {
    const ids = await listerTables();
    const tableId = choisirTable(ids, [
      'suivi_projets', 'Suivi_projets', 'Suivi_des_projets',
    ]) || choisirTable(ids, ['projets', 'Projets']);
    if (!tableId) {
      afficherErreur('Table « suivi_projets » introuvable dans le document.');
      return [];
    }
    const table = versColonnes(await grist.docApi.fetchTable(tableId));
    // Préférer Titre exact (pas Nom / libelle qui peuvent doubler une autre colonne).
    const colTitre = Object.keys(table).find((c) => ['Titre', 'titre', 'Title'].includes(c))
      || colonneParmi(table, ['Nom', 'libelle', 'Libelle']);
    const liste = [];
    const titresVus = new Set();
    (table.id || []).forEach((id, i) => {
      const titre = colTitre ? texte(table[colTitre][i]).trim() : '';
      if (!titre) return;
      const cle = titre.toLowerCase();
      if (titresVus.has(cle)) return;
      titresVus.add(cle);
      liste.push({ id, titre });
    });
    return dedupeParId(liste).sort((a, b) => a.titre.localeCompare(b.titre, 'fr'));
  } catch (err) {
    console.error(err);
    afficherErreur(`Impossible de lire suivi_projets : ${err.message || err}`);
    return [];
  }
}

function titreEvenement(id) {
  if (!id) return '';
  return evenementsProjets.find((e) => e.id === id)?.titre || `#${id}`;
}

/** Normalise pour recherche : minuscules, sans accents, sans ponctuation. */
function normaliserRecherche(texte) {
  return String(texte || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function idsEvenementsDejaSurJour(saufId = 0) {
  if (!brouillon) return new Set();
  return new Set(
    brouillon.evenements
      .map((e) => e.evenement)
      .filter((id) => id && id !== saufId),
  );
}

function filtrerEvenements(saisie, { limite = 12, saufId = 0 } = {}) {
  const q = normaliserRecherche(saisie);
  if (!q) return [];
  const tokens = q.split(' ').filter(Boolean);
  const deja = idsEvenementsDejaSurJour(saufId);
  return evenementsProjets
    .filter((ev) => {
      if (deja.has(ev.id)) return false;
      const cible = normaliserRecherche(ev.titre);
      return tokens.every((t) => cible.includes(t));
    })
    .slice(0, limite);
}

function agentParId(id) {
  return agentsCom.find((a) => a.id === id) || null;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

function libelleCategorieBrut(valeur) {
  const t = texte(valeur).trim();
  if (!t || t === '0') return '';
  return t;
}

function normaliserLigne(rec) {
  const date = versDate(rec.date);
  const cat = resoudreCategorie(rec.categorie);
  return {
    id: Number(rec.id) || rec.id,
    iso: isoDepuisDate(date),
    categorieId: cat?.id || 0,
    categorieLibelle: cat?.libelle || libelleCategorieBrut(rec.categorie),
    categorieCouleur: cat?.couleur || PALETTE[0],
    evenement: idRef(rec.evenement),
    note: texte(rec.note).trim(),
    lien: texte(rec.lien).trim(),
    vues: nombre(rec.vues),
    likes: nombre(rec.likes),
    agent: idRef(rec.agent),
    brut: rec,
  };
}

function indexParJour() {
  const map = new Map();
  for (const rec of enregistrements) {
    const ligne = normaliserLigne(rec);
    if (!ligne.iso) continue;
    if (!map.has(ligne.iso)) map.set(ligne.iso, { evenements: [], absences: [] });
    const bucket = map.get(ligne.iso);
    const aDuContenu = Boolean(
      ligne.categorieId || ligne.categorieLibelle || ligne.evenement || ligne.note || ligne.lien
      || (ligne.vues !== null && ligne.vues !== undefined)
      || (ligne.likes !== null && ligne.likes !== undefined),
    );
    const estAbsence = Boolean(ligne.agent) && !aDuContenu;
    if (estAbsence) bucket.absences.push(ligne);
    else if (aDuContenu) {
      bucket.evenements.push(ligne);
      if (ligne.agent) bucket.absences.push(ligne);
    } else if (ligne.agent) {
      bucket.absences.push(ligne);
    }
  }
  return map;
}

function lignesDansPlage(isoDebut, isoFin) {
  return enregistrements
    .map(normaliserLigne)
    .filter((l) => l.iso && l.iso >= isoDebut && l.iso <= isoFin)
    .sort((a, b) => a.iso.localeCompare(b.iso) || a.id - b.id);
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

/** Ne renvoie que les colonnes réellement mappées (évite l’échec « Unknown column »). */
function champsVersGrist(champs) {
  if (modeDemo) {
    const copie = { ...champs };
    delete copie.id;
    return copie;
  }
  if (!estMappe('date')) {
    throw new Error('Colonne « Date » non mappée dans le panneau du widget.');
  }
  const sortie = {};
  for (const [cle, valeur] of Object.entries(champs)) {
    if (cle === 'id') continue;
    if (!estMappe(cle)) continue;
    if (valeur === undefined) continue;
    // Ne pas envoyer null : certaines colonnes numériques / Ref le rejettent.
    if (valeur === null) continue;
    sortie[mappingsGrist[cle]] = valeur;
  }
  if (!Object.prototype.hasOwnProperty.call(sortie, mappingsGrist.date)) {
    throw new Error('Date manquante pour l’écriture Grist.');
  }
  return sortie;
}

function datePourEcriture(iso) {
  // Timestamp Unix (secondes) : fiable pour les colonnes Date Grist.
  if (modeDemo) return iso;
  const ts = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ts) ? Math.floor(ts / 1000) : iso;
}

function payloadEvenement({ date, categorieId, evenementId, note, lien, vues, likes, agent }) {
  const payload = { date: datePourEcriture(date) };
  if (estMappe('categorie') || modeDemo) {
    payload.categorie = valeurCategoriePourEcriture(categorieId);
  }
  if (estMappe('evenement') || modeDemo) {
    payload.evenement = evenementId || 0;
  }
  if (estMappe('note') || modeDemo) {
    payload.note = note || '';
  }
  if (estMappe('lien') || modeDemo) {
    payload.lien = lien || '';
  }
  if ((estMappe('vues') || modeDemo) && vues !== '' && vues !== null && vues !== undefined) {
    payload.vues = Number(vues);
  }
  if ((estMappe('likes') || modeDemo) && likes !== '' && likes !== null && likes !== undefined) {
    payload.likes = Number(likes);
  }
  if ((estMappe('agent') || modeDemo) && agent) {
    payload.agent = agent;
  }
  return payload;
}

async function ecrireGrist({ creer = [], maj = [], supprimer = [] }) {
  const table = grist.getTable();
  if (supprimer.length) await table.destroy(supprimer);
  if (maj.length) {
    const records = maj.map((m) => {
      const { id, ...champs } = m;
      return { id, ...champsVersGrist(champs) };
    });
    await table.update(records);
  }
  if (creer.length) {
    const records = creer.map((c) => champsVersGrist(c));
    if (!records.length || !Object.keys(records[0] || {}).length) {
      throw new Error('Aucun champ mappé à écrire. Vérifiez le mapping des colonnes du widget.');
    }
    try {
      await table.create(records);
    } catch (err) {
      // Secours : AddRecord via docApi (noms de colonnes déjà résolus).
      const tableId = await grist.getSelectedTableId();
      const actions = records.map((r) => ['AddRecord', tableId, null, r]);
      await grist.docApi.applyUserActions(actions);
      console.warn('create() a échoué, applyUserActions utilisé :', err);
    }
  }
}

async function creerLignes(lignes) {
  if (modeDemo) {
    let max = Math.max(0, ...enregistrements.map((r) => r.id || 0));
    for (const l of lignes) enregistrements.push({ id: ++max, ...l });
    editionId = null;
    rendre();
    return;
  }
  enEcriture = true;
  try {
    await grist.getTable().create(lignes.map(champsVersGrist));
    editionId = null;
  } catch (err) {
    console.error(err);
    afficherErreur(`Création impossible : ${err.message || err}`);
  } finally {
    enEcriture = false;
  }
}

async function majLigne(id, champs) {
  if (modeDemo) {
    const i = enregistrements.findIndex((r) => r.id === id);
    if (i >= 0) enregistrements[i] = { ...enregistrements[i], ...champs, id };
    editionId = null;
    rendre();
    return;
  }
  enEcriture = true;
  try {
    await grist.getTable().update([{ id, ...champsVersGrist({ id, ...champs }) }]);
    editionId = null;
  } catch (err) {
    console.error(err);
    afficherErreur(`Mise à jour impossible : ${err.message || err}`);
  } finally {
    enEcriture = false;
  }
}

async function supprimerLignes(ids) {
  if (!ids.length) return;
  if (modeDemo) {
    const set = new Set(ids);
    enregistrements = enregistrements.filter((r) => !set.has(r.id));
    if (editionId && set.has(editionId)) editionId = null;
    rendre();
    return;
  }
  enEcriture = true;
  try {
    await grist.getTable().destroy(ids);
    if (editionId && ids.includes(editionId)) editionId = null;
  } catch (err) {
    console.error(err);
    afficherErreur(`Suppression impossible : ${err.message || err}`);
  } finally {
    enEcriture = false;
  }
}

function ouvrirModale(iso) {
  const bucket = indexParJour().get(iso) || { evenements: [], absences: [] };
  const originIds = new Set([
    ...bucket.evenements.map((e) => Number(e.id)),
    ...bucket.absences.map((a) => Number(a.id)),
  ].filter((id) => id > 0));
  jourActif = iso;
  editionId = null;
  brouillon = {
    iso,
    evenements: bucket.evenements.map((e) => ({ ...e, id: Number(e.id) || e.id })),
    absents: new Set(bucket.absences.map((a) => a.agent)),
    absencesParAgent: new Map(bucket.absences.map((a) => [a.agent, Number(a.id)])),
    originIds,
    tempId: -1,
  };
  document.body.classList.add('modale-ouverte');
  rendre();
}

function fermerModale() {
  jourActif = null;
  brouillon = null;
  editionId = null;
  document.body.classList.remove('modale-ouverte');
  afficherErreur('');
  rendre();
}

function basculerAbsenceBrouillon(agentId, present) {
  if (!brouillon) return;
  if (present) brouillon.absents.add(agentId);
  else brouillon.absents.delete(agentId);
  rendre();
}

async function supprimerEvenementBrouillon(id) {
  if (!brouillon) return;
  const nid = Number(id);
  brouillon.evenements = brouillon.evenements.filter((e) => Number(e.id) !== nid);
  brouillon.originIds.delete(nid);
  if (Number(editionId) === nid) editionId = null;

  // Suppression immédiate en base pour les lignes déjà persistées.
  if (nid > 0) {
    enregistrements = enregistrements.filter((r) => Number(r.id) !== nid);
    if (!modeDemo) {
      enEcriture = true;
      try {
        await grist.getTable().destroy([nid]);
      } catch (err) {
        console.error(err);
        afficherErreur(`Suppression impossible : ${err.message || err}`);
      } finally {
        enEcriture = false;
      }
    }
  }
  rendre();
}

function appliquerFormulaireBrouillon(fd) {
  const catId = Number(fd.get('categorie') || 0);
  const evId = Number(fd.get('evenement') || 0);
  const note = String(fd.get('note') || '').trim();
  const lien = String(fd.get('lien') || '').trim();
  const vuesRaw = String(fd.get('vues') || '').trim();
  const likesRaw = String(fd.get('likes') || '').trim();
  if (!catId) {
    afficherErreur('Choisissez une catégorie.');
    return false;
  }
  if (!evId && !note) {
    afficherErreur('Choisissez un événement ou saisissez une note.');
    return false;
  }
  const saufEv = editionId
    ? (brouillon.evenements.find((e) => e.id === editionId)?.evenement || 0)
    : 0;
  if (evId && idsEvenementsDejaSurJour(saufEv).has(evId)) {
    afficherErreur('Cet événement est déjà présent sur cette fiche jour.');
    return false;
  }
  afficherErreur('');
  const cat = infoCategorie(catId);
  const ligne = {
    id: editionId || brouillon.tempId--,
    iso: brouillon.iso,
    categorieId: catId,
    categorieLibelle: cat?.libelle || '',
    categorieCouleur: cat?.couleur || PALETTE[0],
    evenement: evId || 0,
    note,
    lien,
    vues: vuesRaw === '' ? null : Number(vuesRaw),
    likes: likesRaw === '' ? null : Number(likesRaw),
    agent: 0,
  };
  if (editionId) {
    const i = brouillon.evenements.findIndex((e) => e.id === editionId);
    if (i >= 0) brouillon.evenements[i] = ligne;
    else brouillon.evenements.push(ligne);
  } else {
    brouillon.evenements.push(ligne);
  }
  editionId = null;
  return true;
}

function normaliserRecLocal(rec, isoFallback) {
  // Garde une date ISO lisible localement (même si Grist a reçu un timestamp).
  const date = typeof rec.date === 'number' ? (isoFallback || isoDepuisDate(versDate(rec.date))) : rec.date;
  return { ...rec, date };
}

function appliquerBrouillonLocalement(iso, aSupprimer, aMaj, aCreer) {
  if (aSupprimer.length) {
    const set = new Set(aSupprimer);
    enregistrements = enregistrements.filter((r) => !set.has(r.id));
  }
  for (const m of aMaj) {
    const i = enregistrements.findIndex((r) => r.id === m.id);
    if (i >= 0) enregistrements[i] = normaliserRecLocal({ ...enregistrements[i], ...m, id: m.id }, iso);
  }
  let max = Math.max(0, ...enregistrements.map((r) => r.id || 0), 0);
  for (const c of aCreer) enregistrements.push(normaliserRecLocal({ id: ++max, ...c }, iso));
}

async function sauvegarderModale() {
  if (!brouillon) return;
  const iso = brouillon.iso;

  if (!modeDemo && !estMappe('date')) {
    afficherErreur('Associez la colonne « Date » du widget avant d’enregistrer.');
    return;
  }
  if (!modeDemo && brouillon.evenements.length
    && !estMappe('categorie') && !estMappe('evenement') && !estMappe('note')) {
    afficherErreur('Mappez au moins « Catégorie », « Événement » ou « Note » pour enregistrer des événements.');
    return;
  }

  const gardes = new Set(
    brouillon.evenements.filter((e) => Number(e.id) > 0).map((e) => Number(e.id)),
  );
  for (const [agentId, absId] of brouillon.absencesParAgent) {
    if (brouillon.absents.has(agentId) && Number(absId) > 0) gardes.add(Number(absId));
  }

  // Les suppressions d’événements sont déjà faites au clic poubelle :
  // on ne retrigger destroy que pour les absences décochées encore dans originIds.
  const aSupprimer = [...brouillon.originIds].filter((id) => !gardes.has(Number(id)));
  const aCreer = [];
  const aMaj = [];

  for (const ev of brouillon.evenements) {
    const payload = payloadEvenement({
      date: iso,
      categorieId: ev.categorieId,
      evenementId: ev.evenement,
      note: ev.note,
      lien: ev.lien,
      vues: ev.vues,
      likes: ev.likes,
      agent: 0,
    });
    if (Number(ev.id) > 0) aMaj.push({ id: Number(ev.id), ...payload });
    else aCreer.push(payload);
  }

  if (brouillon.absents.size && !modeDemo && !estMappe('agent')) {
    afficherErreur('Absences non enregistrées : mappez la colonne « Agent absent ».');
  } else {
    for (const agentId of brouillon.absents) {
      const existant = brouillon.absencesParAgent.get(agentId);
      if (!existant || existant < 0 || !brouillon.originIds.has(existant)) {
        aCreer.push(payloadEvenement({
          date: iso, categorieId: 0, evenementId: 0, note: '', lien: '',
          vues: null, likes: null, agent: agentId,
        }));
      }
    }
  }

  enEcriture = true;
  try {
    if (modeDemo) {
      appliquerBrouillonLocalement(iso, aSupprimer, aMaj, aCreer);
      enEcriture = false;
      fermerModale();
      return;
    }

    await ecrireGrist({ creer: aCreer, maj: aMaj, supprimer: aSupprimer });
    // Mise à jour optimiste pour que le calendrier se remplisse tout de suite.
    appliquerBrouillonLocalement(iso, aSupprimer, aMaj, aCreer);
    enEcriture = false;
    fermerModale();
  } catch (err) {
    console.error('sauvegarderModale', err, { aCreer, aMaj, aSupprimer, mappingsGrist });
    afficherErreur(`Enregistrement impossible : ${err.message || err}`);
    enEcriture = false;
    rendre();
  } finally {
    enEcriture = false;
  }
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

function debutSemaineIso(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const jour = d.getUTCDay() || 7; // lundi = 1 … dimanche = 7
  return ajouterJours(d, 1 - jour);
}

function libelleLignePdf(l) {
  if (l.agent && !l.categorieId && !l.evenement) {
    return `Absence — ${agentParId(l.agent)?.nom || `#${l.agent}`}`;
  }
  return l.evenement ? titreEvenement(l.evenement) : (l.note || 'Sans titre');
}

function exporterPdf(titre, sousTitre, lignes) {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) {
    afficherErreur('Bibliothèque PDF indisponible.');
    return;
  }
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  doc.setFontSize(14);
  doc.text(titre, 14, 16);
  doc.setFontSize(10);
  doc.setTextColor(80);
  doc.text(sousTitre, 14, 22);
  doc.setTextColor(0);

  const body = lignes.map((l) => [
    l.iso,
    l.categorieLibelle || (l.agent ? 'Absence' : ''),
    libelleLignePdf(l),
    l.note || '',
    l.lien || '',
    l.vues ?? '',
    l.likes ?? '',
    l.agent ? (agentParId(l.agent)?.initiales || '') : '',
  ]);

  doc.autoTable({
    startY: 28,
    head: [['Date', 'Catégorie', 'Événement', 'Note', 'Lien', 'Vues', 'Likes', 'Abs.']],
    body: body.length ? body : [['—', 'Aucune entrée sur la période', '', '', '', '', '', '']],
    styles: { fontSize: 8, cellPadding: 1.5, overflow: 'linebreak' },
    headStyles: { fillColor: [0, 0, 145], textColor: 255 },
    columnStyles: {
      0: { cellWidth: 22 },
      1: { cellWidth: 40 },
      2: { cellWidth: 55 },
      3: { cellWidth: 40 },
      4: { cellWidth: 45 },
      5: { cellWidth: 14 },
      6: { cellWidth: 14 },
      7: { cellWidth: 14 },
    },
  });

  const slug = titre.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  doc.save(`plan-com-${slug || 'export'}.pdf`);
}

function plageExport(type, dateDebutIso) {
  const pivot = dateDebutIso || brouillon?.iso || jourActif || aujourdhuiIso();
  const d = new Date(`${pivot}T00:00:00Z`);
  let debut;
  let fin;
  let sousTitre;

  if (type === 'semaine') {
    debut = new Date(d.getTime());
    fin = ajouterJours(debut, 6);
    sousTitre = `Semaine du ${isoDepuisDate(debut)} au ${isoDepuisDate(fin)}`;
  } else if (type === 'mois') {
    debut = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    sousTitre = libelleMois(debut);
  } else if (type === 'jour') {
    debut = d;
    fin = d;
    sousTitre = pivot;
  } else {
    debut = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    fin = new Date(Date.UTC(d.getUTCFullYear(), 11, 31));
    sousTitre = `Année ${d.getUTCFullYear()}`;
  }
  return { isoD: isoDepuisDate(debut), isoF: isoDepuisDate(fin), sousTitre, type };
}

function lancerExport({ format, periode, dateDebut }) {
  const { isoD, isoF, sousTitre, type } = plageExport(periode, dateDebut);
  const lignes = lignesDansPlage(isoD, isoF);
  const slug = sousTitre.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  if (format === 'csv') {
    exporterCsv(`plan-com-${type}-${slug}.csv`, lignes);
  } else {
    exporterPdf(`Plan de communication — ${type}`, sousTitre, lignes);
  }
}

function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exporterCsv(nomFichier, lignes) {
  const entete = ['date', 'categorie', 'evenement', 'note', 'lien', 'vues', 'likes', 'agent'];
  const rows = [entete.join(',')];
  for (const l of lignes) {
    rows.push([
      l.iso,
      l.categorieLibelle || '',
      libelleLignePdf(l),
      l.note || '',
      l.lien || '',
      l.vues ?? '',
      l.likes ?? '',
      l.agent ? (agentParId(l.agent)?.nom || l.agent) : '',
    ].map(csvEscape).join(','));
  }
  const blob = new Blob([`\uFEFF${rows.join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomFichier;
  a.click();
  URL.revokeObjectURL(url);
}

function lignesFicheJourCourante() {
  const iso = brouillon?.iso || jourActif;
  if (!iso) return null;
  if (brouillon && brouillon.iso === iso) {
    return [
      ...brouillon.evenements,
      ...[...brouillon.absents].map((agentId) => ({
        iso,
        categorieLibelle: 'Absence',
        evenement: 0,
        note: '',
        lien: '',
        vues: null,
        likes: null,
        agent: agentId,
      })),
    ];
  }
  return lignesDansPlage(iso, iso);
}

function exportCsvJour() {
  const iso = brouillon?.iso || jourActif;
  const lignes = lignesFicheJourCourante();
  if (!iso || !lignes) {
    afficherErreur('Ouvrez une fiche jour pour l’exporter en CSV.');
    return;
  }
  exporterCsv(`plan-com-jour-${iso}.csv`, lignes);
}

function exportPdfJour() {
  const iso = brouillon?.iso || jourActif;
  const lignes = lignesFicheJourCourante();
  if (!iso || !lignes) {
    afficherErreur('Ouvrez une fiche jour pour l’exporter en PDF.');
    return;
  }
  const d = new Date(`${iso}T00:00:00Z`);
  const libelle = d.toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  exporterPdf('Plan de communication — fiche jour', libelle, lignes);
}

function renduExport() {
  const panel = h('div', { class: 'export-panel', hidden: true, role: 'dialog', 'aria-label': 'Exporter' });
  const selFormat = h('select', { class: 'fr-select', id: 'export-format' },
    h('option', { value: 'pdf' }, 'PDF'),
    h('option', { value: 'csv' }, 'CSV'));
  const selPeriode = h('select', { class: 'fr-select', id: 'export-periode' },
    h('option', { value: 'semaine' }, 'Semaine (7 jours)'),
    h('option', { value: 'mois' }, 'Mois'),
    h('option', { value: 'annee' }, 'Année'),
    h('option', { value: 'jour' }, 'Jour'));
  const inputDebut = h('input', {
    class: 'fr-input',
    id: 'export-debut',
    type: 'date',
    value: brouillon?.iso || jourActif || aujourdhuiIso(),
  });

  panel.append(
    h('div', { class: 'fr-select-group' },
      h('label', { class: 'fr-label', htmlFor: 'export-format' }, 'Type d’export'),
      selFormat),
    h('div', { class: 'fr-select-group' },
      h('label', { class: 'fr-label', htmlFor: 'export-periode' }, 'Période'),
      selPeriode),
    h('div', { class: 'fr-input-group' },
      h('label', { class: 'fr-label', htmlFor: 'export-debut' }, 'Date de début'),
      inputDebut),
    h('div', { class: 'export-panel-actions' },
      h('button', {
        type: 'button',
        class: 'fr-btn fr-btn--tertiary fr-btn--sm',
        onclick: () => { panel.hidden = true; },
      }, 'Fermer'),
      h('button', {
        type: 'button',
        class: 'fr-btn fr-btn--sm',
        onclick: () => {
          lancerExport({
            format: selFormat.value,
            periode: selPeriode.value,
            dateDebut: inputDebut.value,
          });
          panel.hidden = true;
        },
      }, 'Télécharger')));

  const bouton = h('button', {
    type: 'button',
    class: 'fr-btn fr-btn--secondary fr-btn--sm fr-icon-download-line fr-btn--icon-left',
    onclick: (e) => {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
    },
  }, 'Exporter');

  const wrap = h('div', { class: 'export-wrap' }, bouton, panel);
  // Fermer au clic extérieur (une seule fois par rendu).
  setTimeout(() => {
    const fermer = (ev) => {
      if (!wrap.isConnected) {
        document.removeEventListener('click', fermer);
        return;
      }
      if (!wrap.contains(ev.target)) panel.hidden = true;
    };
    document.addEventListener('click', fermer);
  }, 0);
  return wrap;
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

function renduPuce(ev) {
  const titre = ev.evenement ? titreEvenement(ev.evenement) : (ev.note || 'Sans titre');
  return h('span', {
    class: 'puce',
    style: { borderLeftColor: ev.categorieCouleur },
    title: [ev.categorieLibelle, titre, ev.note, ev.lien].filter(Boolean).join('\n'),
  }, titre);
}

function renduAbsences(absences) {
  const vus = new Set();
  const chips = [];
  for (const a of absences) {
    if (vus.has(a.agent)) continue;
    vus.add(a.agent);
    const agent = agentParId(a.agent);
    const label = agent?.initiales || `#${a.agent}`;
    const couleur = agent?.couleur || '#666';
    chips.push(h('span', {
      class: 'abs-chip',
      title: agent?.nom || label,
      style: { background: couleur, color: contrasteTexte(couleur) },
    }, label));
  }
  return h('div', { class: 'absences' }, ...chips);
}

function renduMois(debutMois, index) {
  const annee = debutMois.getUTCFullYear();
  const mois = debutMois.getUTCMonth();
  const nJours = joursDansMois(debutMois);
  const cats = categories.length ? categories : categorieFallback();

  const thead = h('thead', {},
    h('tr', {},
      h('th', { class: 'col-jour' }, 'J'),
      ...cats.map((c) => h('th', { title: c.libelle }, c.court)),
      h('th', { class: 'col-abs' }, 'Absences')));

  const lignes = [];
  for (let j = 1; j <= 31; j += 1) {
    const hors = j > nJours;
    const iso = hors ? '' : isoUTC(annee, mois, j);
    const bucket = iso ? (index.get(iso) || { evenements: [], absences: [] }) : { evenements: [], absences: [] };
    const classes = ['jour'];
    if (hors) classes.push('hors');
    else {
      if (estWeekend(iso)) classes.push('we');
      if (estFerie(iso)) classes.push('ferie');
      if (iso === aujourdhuiIso()) classes.push('aujourdhui');
      if (iso === jourActif) classes.push('actif');
    }

    const parCat = Object.fromEntries(cats.map((c) => [c.id, []]));
    const autres = [];
    for (const ev of bucket.evenements) {
      if (ev.categorieId && parCat[ev.categorieId]) parCat[ev.categorieId].push(ev);
      else if (cats[0]) (parCat[cats[0].id] || autres).push(ev);
      else autres.push(ev);
    }

    const ouvrir = () => {
      if (hors) return;
      ouvrirModale(iso);
    };

    lignes.push(h('tr', { class: classes.join(' ') },
      h('td', {}, h('span', { class: 'jour-num' }, hors ? '' : String(j))),
      ...cats.map((c) => h('td', {},
        h('button', {
          type: 'button',
          class: 'cellule',
          disabled: hors,
          'aria-label': hors ? undefined : `${j} ${libelleMois(debutMois)} — ${c.libelle}`,
          onclick: ouvrir,
        }, ...parCat[c.id].map(renduPuce)))),
      h('td', {},
        h('button', {
          type: 'button',
          class: 'cellule',
          disabled: hors,
          'aria-label': hors ? undefined : `Absences du ${j}`,
          onclick: ouvrir,
        }, renduAbsences(bucket.absences)))));
  }

  return h('section', { class: 'mois' },
    h('div', { class: 'mois-entete' }, libelleMois(debutMois)),
    h('div', { style: { overflowX: 'auto' } },
      h('table', { class: 'cal' }, thead, h('tbody', {}, ...lignes))));
}

function renduLegende() {
  return h('div', { class: 'legende', role: 'list' },
    h('p', { class: 'legende-titre' }, 'Légende'),
    ...categories.map((c) => h('span', { class: 'legende-item', role: 'listitem' },
      h('span', { class: 'pastille', style: { background: c.couleur } }),
      c.libelle)));
}

async function sauverSequencesSansDate() {
  const zone = $('#sequences-sans-date');
  if (!zone) return;
  const texte = zone.value;
  sequencesSansDate = texte;
  sequencesModifiees = false;
  if (modeDemo) {
    try { localStorage.setItem('plan-com-sequences-sans-date', texte); } catch { /* ignore */ }
    sequencesStatut = 'Enregistré (aperçu local)';
    assurerPiedSequences();
    return;
  }
  try {
    await grist.setOptions({ sequencesSansDate: texte });
    sequencesStatut = 'Enregistré';
  } catch (err) {
    console.error(err);
    sequencesStatut = '';
    afficherErreur(`Impossible d’enregistrer les séquences sans date : ${err.message || err}`);
  }
  assurerPiedSequences();
}

function renduNotesSansDate() {
  const focusNotes = document.activeElement?.id === 'sequences-sans-date';
  const valeur = focusNotes
    ? (document.getElementById('sequences-sans-date')?.value ?? sequencesSansDate)
    : sequencesSansDate;

  return h('aside', {
    class: 'notes-sans-date',
    id: 'pied-sequences',
    'aria-label': 'Séquences sans date connue',
  },
  h('div', { class: 'notes-sans-date-inner' },
    h('p', { class: 'bloc-titre' }, 'Séquences sans date connue'),
    h('textarea', {
      class: 'fr-input',
      id: 'sequences-sans-date',
      rows: 3,
      placeholder: 'Ex. : mois de l’innovation — dates à venir — événement à planifier…',
      value: valeur,
      oninput: (e) => {
        sequencesSansDate = e.target.value;
        sequencesModifiees = true;
        sequencesStatut = 'Non enregistré';
        const statut = $('#sequences-statut');
        if (statut) statut.textContent = sequencesStatut;
      },
    }),
    h('div', { class: 'notes-sans-date-actions' },
      h('p', { class: 'notes-sans-date-statut', id: 'sequences-statut' },
        sequencesStatut || (sequencesModifiees ? 'Non enregistré' : '')),
      h('button', {
        type: 'button',
        class: 'fr-btn fr-btn--sm',
        onclick: () => sauverSequencesSansDate(),
      }, 'Enregistrer les notes'))));
}

function assurerPiedSequences() {
  // Conservé pour les callbacks options : le rendu principal place le bloc en bas de page.
  const statut = $('#sequences-statut');
  if (statut) statut.textContent = sequencesStatut || (sequencesModifiees ? 'Non enregistré' : '');
  const zone = $('#sequences-sans-date');
  if (zone && document.activeElement !== zone && !sequencesModifiees) {
    zone.value = sequencesSansDate;
  }
}

function champRechercheEvenement(evEnCours) {
  const idInitial = evEnCours?.evenement || 0;
  const titreInitial = idInitial ? titreEvenement(idInitial) : '';

  const hidden = h('input', {
    type: 'hidden', name: 'evenement', id: 'ajout-evenement-id', value: String(idInitial || 0),
  });
  const input = h('input', {
    class: 'fr-input',
    id: 'ajout-evenement',
    type: 'search',
    autocomplete: 'off',
    placeholder: 'Tapez les premiers caractères…',
    value: '',
  });
  const choixLibelle = h('span', {}, titreInitial || '');
  const choix = h('div', {
    class: 'recherche-ev-choix',
    hidden: !idInitial,
  },
  choixLibelle,
  h('button', {
    type: 'button',
    class: 'fr-btn fr-btn--sm fr-btn--tertiary-no-outline',
    onclick: () => {
      hidden.value = '0';
      choix.hidden = true;
      choixLibelle.textContent = '';
      input.value = '';
      input.focus();
      majSuggestions('');
    },
  }, 'Retirer'));
  const liste = h('ul', {
    class: 'recherche-ev-liste',
    id: 'ajout-evenement-liste',
    role: 'listbox',
    hidden: true,
  });

  function selectionner(ev) {
    hidden.value = String(ev.id);
    choixLibelle.textContent = ev.titre;
    choix.hidden = false;
    input.value = '';
    liste.hidden = true;
    liste.replaceChildren();
  }

  function majSuggestions(saisie) {
    const resultats = filtrerEvenements(saisie, { saufId: idInitial });
    liste.replaceChildren();
    if (!normaliserRecherche(saisie)) {
      liste.hidden = true;
      return;
    }
    if (!resultats.length) {
      liste.append(h('li', { class: 'vide-sug' }, 'Aucun titre disponible'));
      liste.hidden = false;
      return;
    }
    for (const ev of resultats) {
      liste.append(h('li', { role: 'option' },
        h('button', {
          type: 'button',
          onclick: () => selectionner(ev),
        }, ev.titre)));
    }
    liste.hidden = false;
  }

  input.addEventListener('input', () => majSuggestions(input.value));
  input.addEventListener('focus', () => {
    if (normaliserRecherche(input.value)) majSuggestions(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      liste.hidden = true;
      input.blur();
    }
  });

  return h('div', { class: 'fr-input-group recherche-ev' },
    h('label', { class: 'fr-label', htmlFor: 'ajout-evenement' },
      'Événement (suivi_projets)',
      h('span', { class: 'fr-hint-text' },
        'Recherche insensible à la casse, aux accents et à la ponctuation')),
    input,
    hidden,
    choix,
    liste);
}

function renduFormulaire(evEnCours) {
  const enEdition = Boolean(evEnCours);
  return h('form', {
    class: 'form-ajout',
    onsubmit: (e) => {
      e.preventDefault();
      if (appliquerFormulaireBrouillon(new FormData(e.target))) rendre();
    },
  },
  h('p', { class: 'bloc-titre' }, enEdition ? 'Modifier l’événement' : 'Ajouter un événement'),
  h('div', { class: 'fr-select-group' },
    h('label', { class: 'fr-label', htmlFor: 'ajout-categorie' }, 'Catégorie'),
    h('select', { class: 'fr-select', id: 'ajout-categorie', name: 'categorie', required: true },
      h('option', { value: '' }, 'Sélectionner…'),
      ...categories.map((c) => h('option', {
        value: String(c.id),
        selected: evEnCours && evEnCours.categorieId === c.id,
      }, c.libelle)))),
  champRechercheEvenement(evEnCours),
  h('div', { class: 'fr-input-group' },
    h('label', { class: 'fr-label', htmlFor: 'ajout-note' }, 'Note (optionnel)'),
    h('input', {
      class: 'fr-input', id: 'ajout-note', name: 'note', type: 'text', autocomplete: 'off',
      value: evEnCours?.note || '',
    })),
  h('div', { class: 'fr-input-group' },
    h('label', { class: 'fr-label', htmlFor: 'ajout-lien' },
      'Lien',
      h('span', { class: 'fr-hint-text' }, 'Ouverture dans un nouvel onglet')),
    h('input', {
      class: 'fr-input', id: 'ajout-lien', name: 'lien', type: 'url',
      placeholder: 'https://…', autocomplete: 'off',
      value: evEnCours?.lien || '',
    })),
  h('div', { class: 'form-row-2' },
    h('div', { class: 'fr-input-group' },
      h('label', { class: 'fr-label', htmlFor: 'ajout-vues' }, 'Vues (audience)'),
      h('input', {
        class: 'fr-input', id: 'ajout-vues', name: 'vues', type: 'number', min: '0', step: '1',
        value: evEnCours?.vues ?? '',
      })),
    h('div', { class: 'fr-input-group' },
      h('label', { class: 'fr-label', htmlFor: 'ajout-likes' }, 'Likes (audience)'),
      h('input', {
        class: 'fr-input', id: 'ajout-likes', name: 'likes', type: 'number', min: '0', step: '1',
        value: evEnCours?.likes ?? '',
      }))),
  h('div', { class: 'form-actions' },
    enEdition && h('button', {
      type: 'button',
      class: 'fr-btn fr-btn--tertiary',
      onclick: () => { editionId = null; rendre(); },
    }, 'Annuler la modification'),
    h('button', { type: 'submit', class: 'fr-btn fr-btn--secondary' },
      enEdition ? 'Valider la modification' : 'Ajouter à la fiche')));
}

function renduModale() {
  if (!brouillon) return null;

  const d = new Date(`${brouillon.iso}T00:00:00Z`);
  const libelle = d.toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  const evEnCours = editionId
    ? brouillon.evenements.find((e) => e.id === editionId)
    : null;

  const listeEv = brouillon.evenements.length
    ? h('div', { class: 'liste-existante' },
      ...brouillon.evenements.map((ev) => {
        const titre = ev.evenement ? titreEvenement(ev.evenement) : (ev.note || 'Sans titre');
        const metaParts = [ev.categorieLibelle];
        if (ev.note && ev.evenement) metaParts.push(ev.note);
        const metriques = [];
        if (ev.vues !== null && ev.vues !== undefined) metriques.push(`${ev.vues} vues`);
        if (ev.likes !== null && ev.likes !== undefined) metriques.push(`${ev.likes} likes`);
        return h('div', {
          class: `ligne-item${editionId === ev.id ? ' edition' : ''}`,
          style: { borderLeftColor: ev.categorieCouleur },
        },
        h('div', {},
          h('strong', {}, titre),
          h('p', { class: 'meta' }, metaParts.filter(Boolean).join(' — ')),
          ev.lien && h('p', { class: 'meta' },
            h('a', {
              class: 'fr-link fr-link--sm',
              href: normaliserUrl(ev.lien),
              target: '_blank',
              rel: 'noopener noreferrer',
            }, tronquer(ev.lien, 48))),
          metriques.length ? h('p', { class: 'metriques' }, metriques.join(' · ')) : null),
        h('div', { class: 'ligne-actions' },
          h('button', {
            type: 'button',
            class: 'fr-btn fr-btn--sm fr-btn--tertiary-no-outline fr-icon-pencil-line',
            title: 'Modifier',
            'aria-label': 'Modifier',
            disabled: enEcriture,
            onclick: () => { editionId = ev.id; rendre(); },
          }),
          h('button', {
            type: 'button',
            class: 'fr-btn fr-btn--sm fr-btn--tertiary-no-outline fr-icon-delete-line',
            title: 'Supprimer',
            'aria-label': 'Supprimer',
            disabled: enEcriture,
            onclick: () => supprimerEvenementBrouillon(ev.id),
          })));
      }))
    : h('p', { class: 'vide' }, 'Aucun événement ce jour.');

  const toggles = agentsCom.length
    ? h('div', { class: 'abs-toggles' },
      ...agentsCom.map((a) => {
        const actif = brouillon.absents.has(a.id);
        return h('label', {
          class: `abs-toggle${actif ? ' actif' : ''}`,
          style: actif ? { background: a.couleur, borderColor: a.couleur, color: contrasteTexte(a.couleur) } : undefined,
        },
        h('input', {
          type: 'checkbox',
          checked: actif,
          disabled: enEcriture,
          onchange: (e) => basculerAbsenceBrouillon(a.id, e.target.checked),
        }),
        h('span', { class: 'pastille', style: { background: a.couleur } }),
        a.nom);
      }))
    : h('p', { class: 'vide' }, 'Aucun agent avec la case « com » cochée.');

  return h('div', {
    class: 'modale-fond',
    role: 'presentation',
    onclick: (e) => { if (e.target === e.currentTarget && !enEcriture) fermerModale(); },
  },
  h('div', {
    class: 'modale',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'modale-jour-titre',
  },
  h('div', { class: 'modale-entete' },
    h('h2', { id: 'modale-jour-titre' }, libelle),
    h('div', { class: 'modale-entete-actions' },
      h('button', {
        type: 'button',
        class: 'fr-btn fr-btn--sm fr-btn--tertiary fr-icon-file-pdf-line fr-btn--icon-left',
        onclick: exportPdfJour,
      }, 'PDF'),
      h('button', {
        type: 'button',
        class: 'fr-btn fr-btn--sm fr-btn--tertiary',
        onclick: exportCsvJour,
      }, 'CSV'),
      h('button', {
        type: 'button',
        class: 'fr-btn fr-btn--sm fr-btn--tertiary-no-outline fr-icon-close-line',
        title: 'Fermer',
        'aria-label': 'Fermer',
        disabled: enEcriture,
        onclick: fermerModale,
      }))),
  h('div', { class: 'modale-corps' },
    h('div', { class: 'panneau-grille' },
      h('div', {},
        h('p', { class: 'bloc-titre' }, 'Événements du jour'),
        listeEv,
        renduFormulaire(evEnCours)),
      h('div', {},
        h('p', { class: 'bloc-titre' }, 'Absents (agents com)'),
        toggles))),
  h('div', { class: 'modale-pied' },
    h('button', {
      type: 'button',
      class: 'fr-btn fr-btn--secondary',
      disabled: enEcriture,
      onclick: fermerModale,
    }, 'Annuler'),
    h('button', {
      type: 'button',
      class: 'fr-btn',
      disabled: enEcriture,
      onclick: () => sauvegarderModale(),
    }, 'Sauvegarder'))));
}

function rendre() {
  const app = $('#application');
  app.replaceChildren();

  if (!debutBimestre) {
    const n = new Date();
    debutBimestre = new Date(Date.UTC(n.getFullYear(), n.getMonth() - (n.getMonth() % 2), 1));
  }

  if (!modeDemo && enregistrements.length && !('date' in (enregistrements[0] || {}))) {
    $('#message-config').hidden = false;
    return;
  }
  $('#message-config').hidden = true;

  const index = indexParJour();
  const mois2 = ajouterMois(debutBimestre, 1);
  const periode = `${libelleMois(debutBimestre)} — ${libelleMois(mois2)}`;

  app.append(
    h('div', { class: 'barre' },
      h('h1', {}, 'Plan de communication'),
      h('div', { class: 'barre-droite' },
        renduExport(),
        h('div', { class: 'nav-mois' },
          h('button', {
            type: 'button',
            class: 'fr-btn fr-btn--secondary fr-btn--sm fr-icon-arrow-left-s-line fr-btn--icon-left',
            onclick: () => { debutBimestre = ajouterMois(debutBimestre, -2); rendre(); },
          }, '2 mois'),
          h('p', { class: 'periode' }, periode),
          h('button', {
            type: 'button',
            class: 'fr-btn fr-btn--secondary fr-btn--sm fr-icon-arrow-right-s-line fr-btn--icon-right',
            onclick: () => { debutBimestre = ajouterMois(debutBimestre, 2); rendre(); },
          }, '2 mois'),
          h('button', {
            type: 'button',
            class: 'fr-btn fr-btn--tertiary fr-btn--sm',
            onclick: () => {
              const n = new Date();
              debutBimestre = new Date(Date.UTC(n.getFullYear(), n.getMonth() - (n.getMonth() % 2), 1));
              ouvrirModale(aujourdhuiIso());
            },
          }, "Aujourd'hui")))),
    h('div', { class: 'grille-bimestre' },
      renduMois(debutBimestre, index),
      renduMois(mois2, index)),
    renduLegende(),
    renduNotesSansDate(),
  );

  const modale = renduModale();
  if (modale) app.append(modale);

  // Ancien bandeau fixe éventuellement resté sur body.
  for (const orphelin of document.querySelectorAll('body > #pied-sequences')) {
    orphelin.remove();
  }

  // Restaure le focus notes si l’utilisateur était en train de saisir.
  if (sequencesModifiees) {
    const zone = $('#sequences-sans-date');
    if (zone) {
      zone.focus();
      const len = zone.value.length;
      zone.setSelectionRange(len, len);
    }
  }
}

// ---------------------------------------------------------------------------
// Démo + démarrage
// ---------------------------------------------------------------------------

function chargerDemo() {
  modeDemo = true;
  $('#message-demo').hidden = false;
  categories = categorieFallback();
  try { sequencesSansDate = localStorage.getItem('plan-com-sequences-sans-date') || ''; } catch { sequencesSansDate = ''; }
  const y = new Date().getFullYear();
  const m = new Date().getMonth();
  debutBimestre = new Date(Date.UTC(y, m - (m % 2), 1));
  enregistrements = [
    {
      id: 1, date: isoUTC(y, m, 3), categorie: 1, evenement: 1,
      note: 'Brief factice', lien: 'https://exemple.gouv.fr/alpha', vues: 1200, likes: 48, agent: 0,
    },
    {
      id: 2, date: isoUTC(y, m, 3), categorie: 2, evenement: 0,
      note: 'Post démo réseaux', lien: 'https://exemple.gouv.fr/rs', vues: 860, likes: 102, agent: 0,
    },
    { id: 3, date: isoUTC(y, m, 10), categorie: 0, evenement: 0, note: '', lien: '', vues: null, likes: null, agent: 1 },
    { id: 4, date: isoUTC(y, m, 10), categorie: 0, evenement: 0, note: '', lien: '', vues: null, likes: null, agent: 3 },
    {
      id: 5, date: isoUTC(y, m, 17), categorie: 1, evenement: 3,
      note: '', lien: 'https://exemple.gouv.fr/gamma', vues: 430, likes: 19, agent: 0,
    },
    { id: 6, date: isoUTC(y, m, 17), categorie: 0, evenement: 0, note: '', lien: '', vues: null, likes: null, agent: 2 },
    {
      id: 7, date: isoUTC(y, m, 24), categorie: 4, evenement: 4,
      note: 'Stand interne fictif', lien: '', vues: 55, likes: 3, agent: 0,
    },
  ];
}

async function rechargerLiees() {
  const jeton = ++jetonLiees;
  const [cats, agents, evs] = await Promise.all([
    lireCategories(),
    lireAgents(),
    lireEvenements(),
  ]);
  // Ignore les réponses obsolètes si plusieurs onRecords se chevauchent.
  if (jeton !== jetonLiees) return;
  categories = cats;
  agentsCom = agents;
  evenementsProjets = evs;
}

async function demarrerGrist() {
  grist.ready({
    requiredAccess: 'full',
    columns: COLONNES,
    onEditOptions: () => {},
  });

  grist.onOptions((options) => {
    const texte = options?.sequencesSansDate;
    if (typeof texte !== 'string') return;
    if (sequencesModifiees) return;
    sequencesSansDate = texte;
    sequencesStatut = '';
    assurerPiedSequences();
  });

  grist.onRecords(async (records, mappings) => {
    if (enEcriture) return;
    modeDemo = false;
    $('#message-demo').hidden = true;
    mappingsGrist = mappings || {};

    const mappes = (records || []).map((r) => {
      let mappe = null;
      try { mappe = grist.mapColumnNames(r); } catch { /* ignore */ }
      if (mappe) return mappe;
      // Repli manuel si mapColumnNames renvoie null (mapping incomplet).
      const out = { id: r.id };
      for (const [widget, table] of Object.entries(mappingsGrist)) {
        if (table && Object.prototype.hasOwnProperty.call(r, table)) out[widget] = r[table];
      }
      return out;
    });

    const dateMappee = Boolean(mappingsGrist.date)
      || (mappes[0] && Object.prototype.hasOwnProperty.call(mappes[0], 'date'));
    if (!dateMappee) {
      enregistrements = mappes;
      $('#message-config').hidden = false;
      $('#application').replaceChildren();
      return;
    }

    enregistrements = mappes;
    if (!brouillon) afficherErreur('');
    await rechargerLiees();
    rendre();
  }, { keepEncoded: true, expandRefs: false });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && brouillon && !enEcriture) fermerModale();
});

if (window.grist && window !== window.parent) {
  demarrerGrist().catch((err) => {
    console.error(err);
    afficherErreur(String(err.message || err));
  });
} else {
  chargerDemo();
  rechargerLiees().then(() => rendre());
}
