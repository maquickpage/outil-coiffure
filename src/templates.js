export const TEMPLATE_IDS = ['classic', 'contrast', 'drama'];

export const TEMPLATES = [
  {
    id: 'classic',
    name: 'Classic',
    subtitle: 'élégance intemporelle',
    description: "Tons crème et or feutré, typographie serif raffinée. Le design d'origine.",
    previewDescription: 'Crème, or feutré et typographie raffinée.',
  },
  {
    id: 'contrast',
    name: 'Contrast',
    subtitle: 'noir & blanc éditorial',
    description: 'Style magazine, photos noir & blanc, bandes plein écran très graphiques.',
    previewDescription: 'Noir et blanc, esprit magazine très graphique.',
  },
  {
    id: 'drama',
    name: 'Drama',
    subtitle: 'noir & or',
    description: 'Ambiance haute couture : fond noir, signature dorée, fort contraste.',
    previewDescription: 'Noir et or, ambiance haute couture.',
  },
];

export const TEMPLATE_LABELS = Object.fromEntries(
  TEMPLATES.map(template => [template.id, `${template.name} — ${template.subtitle}`])
);

const TEMPLATE_ID_SET = new Set(TEMPLATE_IDS);

export function normalizeTemplateId(value, fallback = 'classic') {
  return TEMPLATE_ID_SET.has(value) ? value : fallback;
}

export function isTemplateId(value) {
  return TEMPLATE_ID_SET.has(value);
}
