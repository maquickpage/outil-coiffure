// ====================================================================
// I18N — Outil coiffure admin (FR / EN / ZH)
// ====================================================================

const TRANSLATIONS = {
  fr: {
    // Topbar
    'app.title': 'Outil coiffure',
    'app.logout': 'Déconnexion',

    // Login
    'login.title': 'Outil coiffure',
    'login.subtitle': 'Connexion administrateur',
    'login.email': 'Email',
    'login.password': 'Mot de passe',
    'login.submit': 'Se connecter',
    'login.error_default': 'Erreur de connexion',

    // Stats
    'stats.title': 'Statistiques',
    'stats.total': 'Salons en base',
    'stats.with_screenshot': 'Avec capture',
    'stats.without_screenshot': 'Sans capture',
    'stats.csv_sources': 'Imports CSV',
    'stats.clean_names': 'Noms nettoyés',
    'stats.never_contacted': 'Jamais contactés',

    // CSV import
    'csv.section_title': 'CSV',
    'csv.export_title': 'Exporter CSV enrichi',
    'csv.export_help': 'Choisissez précisément les groupes et sources à inclure dans votre export. Vous pouvez composer un export partiel (quelques sources d\'un groupe) ou complet.',
    'csv.open_export': 'Composer mon export',
    'contacted.title': 'Historique cold-mail',
    'contacted.help': 'Marque en base les salons déjà contactés par les campagnes Smartlead passées, pour pouvoir les exclure des prochains exports. Prévisualisez d\'abord : rien n\'est écrit tant que vous n\'avez pas confirmé.',
    'contacted.preview': 'Prévisualiser',
    'contacted.apply': 'Importer',
    'contacted.confirm': 'Marquer ces salons comme déjà contactés ? L\'opération est rejouable sans risque.',
    'contacted.seed_rows': 'lignes dans le fichier',
    'contacted.by_slug': 'Matchés par slug',
    'contacted.by_email': 'Matchés par e-mail',
    'contacted.missed': 'Introuvables en base',
    'contacted.rate': 'Taux de matching',
    'contacted.will_flag': 'Nouveaux salons qui seront marqués',
    'contacted.never': 'Jamais contactés après import',
    'contacted.applied': 'salons marqués comme contactés',
    'csv.title': 'Importer un CSV',
    'csv.choose_file': 'Choisir un ou plusieurs fichiers',
    'csv.no_file': 'Aucun fichier choisi',
    'csv.source_name_placeholder': 'Nom de la source (ex : coiffeurs-auvergne-ain)',
    'csv.source_name_placeholder_optional': 'Nom de la source (optionnel — auto-déduit du fichier)',
    'csv.source_auto_placeholder': 'Auto : « {name} » (ou tape pour personnaliser)',
    'csv.source_auto_multi': 'Auto-déduit pour chaque fichier',
    'csv.files_selected': '{count} fichiers sélectionnés',
    'csv.hint_default': 'Vous pouvez charger un ou plusieurs CSV en même temps. En cas de chargement multiple, le nom de chaque source est déduit automatiquement.',
    'csv.hint_single': 'Si vous laissez le champ vide, le nom de la source sera : <strong>{name}</strong>',
    'csv.hint_multi': '<strong>{count} fichiers</strong> seront importés dans le groupe sélectionné. Sources auto : <em>{names}</em>',
    'csv.importing_progress': 'Import {current}/{total} : {name}…',
    'csv.import_btn': 'Importer',
    'csv.importing': 'Import en cours…',

    // Salons table
    'table.title': 'Salons',
    'table.search_placeholder': 'Rechercher (nom, ville, slug)…',
    'table.all_sources': 'Toutes les sources',
    'table.contact_all': 'Contact : tous',
    'table.contact_never': 'Jamais contactés',
    'table.contact_done': 'Déjà contactés',
    'table.refresh': 'Actualiser',
    'table.batch_screenshots': 'Générer les captures',
    'table.clean_names': 'Nettoyer les noms (IA)',
    'table.clean_names_tooltip': 'Nettoie les noms à rallonge via IA (Azure GPT)',
    'table.correct_presentation': 'Corriger présentation',
    'table.correct_presentation_tooltip': 'Reformule via IA le texte de présentation des salons sélectionnés',
    'table.domain_suggestions': 'Suggérer noms de domaine (IA)',
    'table.domain_suggestions_tooltip': 'Génère 10 idées de noms de domaine par salon (sans extension TLD), à utiliser ensuite dans le parcours d\'achat',
    'table.export_csv': 'Exporter CSV enrichi',
    'table.delete_selection': 'Supprimer la sélection',
    'table.selection_count': '<strong>{count}</strong> ligne(s) sélectionnée(s)',
    'table.clear_selection': 'Tout désélectionner',
    'table.page_size_label': 'Par page :',
    'table.cross_pages_prompt': 'Les <strong>{count}</strong> lignes de cette page sont sélectionnées.',
    'table.cross_pages_action': 'Sélectionner les <strong>{total}</strong> salons de toutes les pages',
    'table.cross_pages_all_selected': 'Les <strong>{total}</strong> salons de toutes les pages sont sélectionnés.',
    'table.cross_pages_clear': 'Annuler la sélection',
    'col.nom_scrappe': 'Nom scrappé',
    'col.nom_final': 'Nom final',
    'col.editable_hint': '(éditable)',
    'col.ville': 'Ville',
    'col.note': 'Note',
    'col.url_landing': 'URL Landing',
    'col.url_edition': 'URL Édition',
    'col.capture': 'Capture',
    'col.cold_mail': 'Cold mail',
    'col.actions': 'Actions',
    'col.presentation_scrappee': 'Présentation scrappée',
    'col.presentation_corrigee': 'Présentation corrigée',
    'col.domain_suggestions': 'Domaines suggérés',
    'cell.no_domain_suggestions': 'Aucun (lancer IA)',
    'cell.no_screenshot': 'non',
    'cell.cold_never': 'jamais',
    'cell.edit_link': 'Modifier',
    'cell.edit_link_tooltip': 'Lien d\'édition à envoyer au coiffeur',
    'cell.copy_tooltip': 'Copier le lien',
    'cell.click_to_edit': 'Cliquer pour éditer',
    'modal.presentation_scrappee': 'Présentation scrappée (Meta description CSV)',
    'modal.presentation_corrigee': 'Présentation corrigée',
    'modal.save': 'Enregistrer',
    'modal.saved': 'Enregistré',
    'modal.reset': 'Vider (revenir au défaut)',
    'run.actions_label': 'Actions à lancer :',
    'run.button': 'Run',
    'run.confirm': 'Lancer {actions} sur {count} salon(s) sélectionné(s) ?',

    // Composer d'export
    'export.title': 'Composer mon export CSV',
    'export.help': 'Cochez les groupes et sources à inclure. Décocher un groupe désélectionne tous ses sources ; décocher des sources individuels permet un export partiel.',
    'export.format': 'Format :',
    'export.format_smartlead': 'Smartlead',
    'export.format_smartlead_hint': '(7 colonnes pour mailing)',
    'export.format_full': 'Complet',
    'export.format_full_hint': '(toutes les colonnes utiles)',
    'export.domain': 'Domaine e-mail :',
    'export.domain_all': 'Tous les domaines',
    'export.limit': 'Limite :',
    'export.exclude_contacted': 'Exclure les salons déjà contactés (même e-mail compris)',
    'export.select_all': 'Tout cocher',
    'export.deselect_all': 'Tout décocher',
    'export.count_label': '<strong>{count}</strong> salons sélectionnés',
    'export.empty': 'Aucun groupe ni source à exporter. Importez d\'abord un CSV.',
    'export.cancel': 'Annuler',
    'export.confirm': 'Télécharger le CSV',

    // Row actions
    'action.capture': 'Capture',
    'action.delete': 'Supprimer',
    'action.deleting': '…',

    // Pagination
    'page.previous': '←',
    'page.next': '→',

    // Modals & confirmations
    'confirm.delete_salon': 'Supprimer {slug} ?',
    'confirm.batch_screenshots': 'Lancer la génération des captures manquantes ?',
    'confirm.batch_screenshots_source': ' (source : {source})',
    'confirm.batch_screenshots_all': ' (toutes sources)',
    'confirm.capture_selection': 'Générer les captures pour {count} salon(s) sélectionné(s) ?',
    'confirm.correct_presentation': 'Reformuler le texte de présentation de {count} salon(s) sélectionné(s) via IA ?\n\nLeurs descriptions seront remplacées par des versions plus chaleureuses et naturelles.',
    'confirm.delete_selection_1': 'Supprimer définitivement {count} salon(s) sélectionné(s) ?\n\nCette action est irréversible.',
    'confirm.delete_selection_2': 'Vraiment ? Cette action ne peut pas être annulée. Cliquer sur OK pour confirmer.',
    'msg.no_presentation_to_correct': 'Aucune présentation à corriger.',
    'confirm.clean_names_all': 'Lancer le nettoyage IA pour toutes les sources ?',
    'confirm.clean_names_source': 'Lancer le nettoyage IA des noms pour la source "{source}" ?',
    'confirm.clean_names_note': '\n\n(Seuls les noms pas encore nettoyés sont traités.)',
    'msg.no_names_to_clean': 'Aucun nom à nettoyer.',
    'msg.all_clean_already': 'Tous les noms sont déjà nettoyés ({total}/{total}).',
    'msg.force_clean_question': 'Voulez-vous re-traiter tous les noms (utile si le prompt a été amélioré) ?',
    'job.status_label': '[{status}] {done}/{total} ({errors} erreurs)',

    // Groupes
    'groups.title': 'Groupes',
    'groups.help': 'Organisez vos imports CSV en projets distincts. Chaque groupe est sauvegardé automatiquement et accessible plus tard.',
    'groups.all_salons': 'Tous les salons',
    'groups.without_group': 'Salons sans groupe',
    'groups.orphan_help': 'Ces salons ne sont rattachés à aucun groupe. Créez un groupe et assignez-les depuis le filtre de source.',
    'groups.new': 'Nouveau groupe',
    'groups.rename': 'Renommer',
    'groups.rename_tooltip': 'Renommer ce groupe',
    'groups.delete': 'Supprimer',
    'groups.delete_tooltip': 'Supprimer ce groupe (les salons restent dans la base)',
    'groups.salons_label': 'salons',
    'groups.sources_label': 'imports CSV',
    'groups.import_no_group': '— Aucun groupe (par défaut) —',
    'groups.prompt_new_name': 'Nom du nouveau groupe :',
    'groups.prompt_new_description': 'Description (optionnelle) :',
    'groups.prompt_rename': 'Nouveau nom du groupe :',
    'groups.confirm_delete': 'Supprimer le groupe « {name} » ?\n\nLes {count} salons qu\'il contient ne seront PAS supprimés — ils retourneront simplement dans « Salons sans groupe ».',

    // Bulk actions
    'bulk.count_label': '{count} salons correspondent au filtre actif',
    'bulk.move': 'Déplacer',
    'bulk.delete': 'Supprimer',
    'bulk.choose_target': '— Choisir un groupe cible —',
    'bulk.target_no_group': 'Retirer du groupe (devient « sans groupe »)',
    'bulk.confirm_move': 'Déplacer {count} salons vers « {target} » ?',
    'bulk.moved_success': '{count} salons déplacés avec succès.',
    'bulk.confirm_delete_1': 'Supprimer définitivement {count} salons ?\n\nCette action est irréversible — toutes les données, captures et personnalisations seront perdues.',
    'bulk.confirm_delete_2': 'Vraiment ? Tape sur OK pour confirmer définitivement.',
    'bulk.deleted_success': '{count} salons supprimés.',

    // Errors
    'err.generic': 'Erreur',
    'err.empty_field': 'vide',
    'err.saving': '…'
  },

  en: {
    'app.title': 'Hairdresser Tool',
    'app.logout': 'Log out',

    'login.title': 'Hairdresser Tool',
    'login.subtitle': 'Admin login',
    'login.email': 'Email',
    'login.password': 'Password',
    'login.submit': 'Sign in',
    'login.error_default': 'Login error',

    'stats.title': 'Statistics',
    'stats.total': 'Salons in DB',
    'stats.with_screenshot': 'With screenshot',
    'stats.without_screenshot': 'Without screenshot',
    'stats.csv_sources': 'CSV imports',
    'stats.clean_names': 'Cleaned names',
    'stats.never_contacted': 'Never contacted',

    'csv.section_title': 'CSV',
    'csv.export_title': 'Export enriched CSV',
    'csv.export_help': 'Pick precisely which groups and sources to include in your export. Compose partial exports (some sources within a group) or full ones.',
    'csv.open_export': 'Compose my export',
    'contacted.title': 'Cold-mail history',
    'contacted.help': 'Flags in the database the salons already reached by past Smartlead campaigns, so you can exclude them from future exports. Preview first: nothing is written until you confirm.',
    'contacted.preview': 'Preview',
    'contacted.apply': 'Import',
    'contacted.confirm': 'Flag these salons as already contacted? The operation is safe to re-run.',
    'contacted.seed_rows': 'rows in the file',
    'contacted.by_slug': 'Matched by slug',
    'contacted.by_email': 'Matched by email',
    'contacted.missed': 'Not found in database',
    'contacted.rate': 'Match rate',
    'contacted.will_flag': 'New salons that will be flagged',
    'contacted.never': 'Never contacted after import',
    'contacted.applied': 'salons flagged as contacted',
    'csv.title': 'Import a CSV',
    'csv.choose_file': 'Choose one or more files',
    'csv.no_file': 'No file chosen',
    'csv.source_name_placeholder': 'Source name (e.g. hairdressers-region-name)',
    'csv.source_name_placeholder_optional': 'Source name (optional — auto-derived from filename)',
    'csv.source_auto_placeholder': 'Auto: "{name}" (or type to customize)',
    'csv.source_auto_multi': 'Auto-derived for each file',
    'csv.files_selected': '{count} files selected',
    'csv.hint_default': 'You can upload one or several CSVs at once. With multiple files, each source name is auto-derived from its filename.',
    'csv.hint_single': 'If you leave the field empty, the source name will be: <strong>{name}</strong>',
    'csv.hint_multi': '<strong>{count} files</strong> will be imported into the selected group. Auto sources: <em>{names}</em>',
    'csv.importing_progress': 'Importing {current}/{total}: {name}…',
    'csv.import_btn': 'Import',
    'csv.importing': 'Importing…',

    'table.title': 'Salons',
    'table.search_placeholder': 'Search (name, city, slug)…',
    'table.all_sources': 'All sources',
    'table.contact_all': 'Contact: all',
    'table.contact_never': 'Never contacted',
    'table.contact_done': 'Already contacted',
    'table.refresh': 'Refresh',
    'table.batch_screenshots': 'Generate screenshots',
    'table.clean_names': 'Clean names (AI)',
    'table.clean_names_tooltip': 'Cleans long names via AI (Azure GPT)',
    'table.correct_presentation': 'Fix presentation',
    'table.correct_presentation_tooltip': 'Rewrites the presentation text of selected salons via AI',
    'table.domain_suggestions': 'Suggest domain names (AI)',
    'table.domain_suggestions_tooltip': 'Generates 10 domain name ideas per salon (no TLD extension), to be used later in the checkout flow',
    'table.export_csv': 'Export enriched CSV',
    'table.delete_selection': 'Delete selection',
    'table.selection_count': '<strong>{count}</strong> row(s) selected',
    'table.clear_selection': 'Deselect all',
    'table.page_size_label': 'Per page:',
    'table.cross_pages_prompt': 'The <strong>{count}</strong> rows on this page are selected.',
    'table.cross_pages_action': 'Select all <strong>{total}</strong> salons across pages',
    'table.cross_pages_all_selected': 'All <strong>{total}</strong> salons across pages are selected.',
    'table.cross_pages_clear': 'Cancel selection',
    'col.nom_scrappe': 'Scraped name',
    'col.nom_final': 'Final name',
    'col.editable_hint': '(editable)',
    'col.ville': 'City',
    'col.note': 'Rating',
    'col.url_landing': 'Landing URL',
    'col.url_edition': 'Edit URL',
    'col.capture': 'Screenshot',
    'col.cold_mail': 'Cold mail',
    'col.actions': 'Actions',
    'col.presentation_scrappee': 'Scraped presentation',
    'col.presentation_corrigee': 'Fixed presentation',
    'col.domain_suggestions': 'Suggested domains',
    'cell.no_domain_suggestions': 'None (run AI)',
    'cell.no_screenshot': 'no',
    'cell.cold_never': 'never',
    'cell.edit_link': 'Edit',
    'cell.edit_link_tooltip': 'Edit link to send to the salon owner',
    'cell.copy_tooltip': 'Copy link',
    'cell.click_to_edit': 'Click to edit',
    'modal.presentation_scrappee': 'Scraped presentation (CSV meta description)',
    'modal.presentation_corrigee': 'Fixed presentation',
    'modal.save': 'Save',
    'modal.saved': 'Saved',
    'modal.reset': 'Clear (revert to default)',
    'run.actions_label': 'Actions to run:',
    'run.button': 'Run',
    'run.confirm': 'Run {actions} on {count} selected salon(s)?',

    // Export composer
    'export.title': 'Compose my CSV export',
    'export.help': 'Check the groups and sources to include. Unchecking a group deselects all its sources; unchecking individual sources allows partial exports.',
    'export.format': 'Format:',
    'export.format_smartlead': 'Smartlead',
    'export.format_smartlead_hint': '(7 columns for mailing)',
    'export.format_full': 'Full',
    'export.format_full_hint': '(all useful columns)',
    'export.domain': 'Email domain:',
    'export.domain_all': 'All domains',
    'export.limit': 'Limit:',
    'export.exclude_contacted': 'Exclude already contacted salons (same email included)',
    'export.select_all': 'Select all',
    'export.deselect_all': 'Deselect all',
    'export.count_label': '<strong>{count}</strong> salons selected',
    'export.empty': 'No groups or sources to export. Import a CSV first.',
    'export.cancel': 'Cancel',
    'export.confirm': 'Download CSV',

    'action.capture': 'Capture',
    'action.delete': 'Delete',
    'action.deleting': '…',

    'page.previous': '←',
    'page.next': '→',

    'confirm.delete_salon': 'Delete {slug}?',
    'confirm.batch_screenshots': 'Start generating missing screenshots?',
    'confirm.batch_screenshots_source': ' (source: {source})',
    'confirm.batch_screenshots_all': ' (all sources)',
    'confirm.capture_selection': 'Generate screenshots for {count} selected salon(s)?',
    'confirm.correct_presentation': 'Rewrite the presentation text of {count} selected salon(s) via AI?\n\nTheir descriptions will be replaced with more natural and warm versions.',
    'confirm.delete_selection_1': 'Permanently delete {count} selected salon(s)?\n\nThis action cannot be undone.',
    'confirm.delete_selection_2': 'Really? This action cannot be undone. Click OK to confirm.',
    'msg.no_presentation_to_correct': 'No presentation to fix.',
    'confirm.clean_names_all': 'Start AI cleaning for all sources?',
    'confirm.clean_names_source': 'Start AI cleaning for source "{source}"?',
    'confirm.clean_names_note': '\n\n(Only names not yet cleaned will be processed.)',
    'msg.no_names_to_clean': 'No names to clean.',
    'msg.all_clean_already': 'All names have been cleaned already ({total}/{total}).',
    'msg.force_clean_question': 'Do you want to re-process all names (useful if the prompt was improved)?',
    'job.status_label': '[{status}] {done}/{total} ({errors} errors)',

    // Groups
    'groups.title': 'Groups',
    'groups.help': 'Organize your CSV imports into distinct projects. Each group is saved automatically and can be reopened later.',
    'groups.all_salons': 'All salons',
    'groups.without_group': 'Salons without group',
    'groups.orphan_help': 'These salons are not assigned to any group. Create a group and assign them via the source filter.',
    'groups.new': 'New group',
    'groups.rename': 'Rename',
    'groups.rename_tooltip': 'Rename this group',
    'groups.delete': 'Delete',
    'groups.delete_tooltip': 'Delete this group (salons stay in the database)',
    'groups.salons_label': 'salons',
    'groups.sources_label': 'CSV imports',
    'groups.import_no_group': '— No group (default) —',
    'groups.prompt_new_name': 'Name of the new group:',
    'groups.prompt_new_description': 'Description (optional):',
    'groups.prompt_rename': 'New name for the group:',
    'groups.confirm_delete': 'Delete group "{name}"?\n\nThe {count} salons it contains will NOT be deleted — they will simply return to "Salons without group".',

    // Bulk actions
    'bulk.count_label': '{count} salons match the active filter',
    'bulk.move': 'Move',
    'bulk.delete': 'Delete',
    'bulk.choose_target': '— Choose a target group —',
    'bulk.target_no_group': 'Remove from group (becomes "without group")',
    'bulk.confirm_move': 'Move {count} salons to "{target}"?',
    'bulk.moved_success': '{count} salons moved successfully.',
    'bulk.confirm_delete_1': 'Permanently delete {count} salons?\n\nThis action cannot be undone — all data, screenshots and customizations will be lost.',
    'bulk.confirm_delete_2': 'Really? Click OK to confirm permanently.',
    'bulk.deleted_success': '{count} salons deleted.',

    'err.generic': 'Error',
    'err.empty_field': 'empty',
    'err.saving': '…'
  },

  zh: {
    'app.title': '理发店工具',
    'app.logout': '登出',

    'login.title': '理发店工具',
    'login.subtitle': '管理员登录',
    'login.email': '邮箱',
    'login.password': '密码',
    'login.submit': '登录',
    'login.error_default': '登录错误',

    'stats.title': '统计',
    'stats.total': '数据库中的沙龙',
    'stats.with_screenshot': '已截图',
    'stats.without_screenshot': '未截图',
    'stats.csv_sources': 'CSV 导入',
    'stats.clean_names': '已清理名称',
    'stats.never_contacted': '未联系',

    'csv.section_title': 'CSV',
    'csv.export_title': '导出增强的 CSV',
    'csv.export_help': '精确选择要包含在导出中的分组和来源。您可以组合部分导出（分组中的某些来源）或完整导出。',
    'csv.open_export': '组合我的导出',
    'contacted.title': '冷邮件历史',
    'contacted.help': '把过往 Smartlead campaign 已经联系过的沙龙标记到数据库里，以便在后续导出中排除它们。请先预览：确认之前不会写入任何数据。',
    'contacted.preview': '预览',
    'contacted.apply': '导入',
    'contacted.confirm': '确认把这些沙龙标记为已联系？该操作可重复执行，不会出错。',
    'contacted.seed_rows': '条记录（文件中）',
    'contacted.by_slug': '按 slug 匹配',
    'contacted.by_email': '按邮箱匹配',
    'contacted.missed': '数据库中未找到',
    'contacted.rate': '匹配率',
    'contacted.will_flag': '将新标记的沙龙数',
    'contacted.never': '导入后未联系数',
    'contacted.applied': '个沙龙已标记为已联系',
    'csv.title': '导入 CSV',
    'csv.choose_file': '选择一个或多个文件',
    'csv.no_file': '未选择文件',
    'csv.source_name_placeholder': '来源名称（例如：理发店-地区-名称）',
    'csv.source_name_placeholder_optional': '来源名称（可选 — 从文件名自动推断）',
    'csv.source_auto_placeholder': '自动：「{name}」（或输入以自定义）',
    'csv.source_auto_multi': '为每个文件自动推断',
    'csv.files_selected': '已选择 {count} 个文件',
    'csv.hint_default': '您可以一次上传一个或多个 CSV。批量上传时，每个来源名称会根据文件名自动推断。',
    'csv.hint_single': '如果留空此字段，来源名称将为：<strong>{name}</strong>',
    'csv.hint_multi': '<strong>{count} 个文件</strong>将导入所选分组。自动来源：<em>{names}</em>',
    'csv.importing_progress': '正在导入 {current}/{total}：{name}…',
    'csv.import_btn': '导入',
    'csv.importing': '导入中…',

    'table.title': '沙龙',
    'table.search_placeholder': '搜索（名称、城市、slug）…',
    'table.all_sources': '所有来源',
    'table.contact_all': '联系状态：全部',
    'table.contact_never': '未联系',
    'table.contact_done': '已联系',
    'table.refresh': '刷新',
    'table.batch_screenshots': '生成截图',
    'table.clean_names': '清理名称（AI）',
    'table.clean_names_tooltip': '通过 AI 清理冗长的名称（Azure GPT）',
    'table.correct_presentation': '修正介绍',
    'table.correct_presentation_tooltip': '通过 AI 重写所选沙龙的介绍文本',
    'table.domain_suggestions': '建议域名（AI）',
    'table.domain_suggestions_tooltip': '为每个沙龙生成 10 个域名创意（不含 TLD 后缀），稍后在结账流程中使用',
    'table.export_csv': '导出增强的 CSV',
    'table.delete_selection': '删除所选',
    'table.selection_count': '已选 <strong>{count}</strong> 行',
    'table.clear_selection': '取消全部选择',
    'table.page_size_label': '每页：',
    'table.cross_pages_prompt': '本页的 <strong>{count}</strong> 行已选中。',
    'table.cross_pages_action': '选择所有 <strong>{total}</strong> 个沙龙（所有页面）',
    'table.cross_pages_all_selected': '所有页面的 <strong>{total}</strong> 个沙龙已全部选中。',
    'table.cross_pages_clear': '取消选择',
    'col.nom_scrappe': '抓取的名称',
    'col.nom_final': '最终名称',
    'col.editable_hint': '（可编辑）',
    'col.ville': '城市',
    'col.note': '评分',
    'col.url_landing': '着陆页 URL',
    'col.url_edition': '编辑 URL',
    'col.capture': '截图',
    'col.cold_mail': '冷邮件',
    'col.actions': '操作',
    'col.presentation_scrappee': '抓取的介绍',
    'col.presentation_corrigee': '修正的介绍',
    'col.domain_suggestions': '建议的域名',
    'cell.no_domain_suggestions': '无（运行 AI）',
    'cell.no_screenshot': '无',
    'cell.cold_never': '未发送',
    'cell.edit_link': '编辑',
    'cell.edit_link_tooltip': '发送给沙龙老板的编辑链接',
    'cell.copy_tooltip': '复制链接',
    'cell.click_to_edit': '点击编辑',
    'modal.presentation_scrappee': '抓取的介绍（CSV 元描述）',
    'modal.presentation_corrigee': '修正的介绍',
    'modal.save': '保存',
    'modal.saved': '已保存',
    'modal.reset': '清空（恢复默认）',
    'run.actions_label': '要运行的操作：',
    'run.button': 'Run',
    'run.confirm': '对 {count} 个所选沙龙运行 {actions}？',

    // 导出组合器
    'export.title': '组合我的 CSV 导出',
    'export.help': '勾选要包含的分组和来源。取消勾选分组会取消其所有来源；取消勾选单个来源可实现部分导出。',
    'export.format': '格式：',
    'export.format_smartlead': 'Smartlead',
    'export.format_smartlead_hint': '（7 列用于邮件营销）',
    'export.format_full': '完整',
    'export.format_full_hint': '（所有有用的列）',
    'export.domain': '邮箱域名：',
    'export.domain_all': '全部域名',
    'export.limit': '数量上限：',
    'export.exclude_contacted': '排除已联系的沙龙（含同邮箱的其他门店）',
    'export.select_all': '全选',
    'export.deselect_all': '取消全选',
    'export.count_label': '已选 <strong>{count}</strong> 个沙龙',
    'export.empty': '没有可导出的分组或来源。请先导入 CSV。',
    'export.cancel': '取消',
    'export.confirm': '下载 CSV',

    'action.capture': '截图',
    'action.delete': '删除',
    'action.deleting': '…',

    'page.previous': '←',
    'page.next': '→',

    'confirm.delete_salon': '删除 {slug}？',
    'confirm.batch_screenshots': '开始生成缺失的截图？',
    'confirm.batch_screenshots_source': '（来源：{source}）',
    'confirm.batch_screenshots_all': '（所有来源）',
    'confirm.capture_selection': '为 {count} 个所选沙龙生成截图？',
    'confirm.correct_presentation': '通过 AI 重写 {count} 个所选沙龙的介绍文本？\n\n他们的描述将被替换为更自然温暖的版本。',
    'confirm.delete_selection_1': '永久删除 {count} 个所选沙龙？\n\n此操作无法撤销。',
    'confirm.delete_selection_2': '确定吗？此操作无法撤销。点击"确定"以确认。',
    'msg.no_presentation_to_correct': '没有要修正的介绍。',
    'confirm.clean_names_all': '为所有来源启动 AI 清理？',
    'confirm.clean_names_source': '为来源 "{source}" 启动 AI 清理？',
    'confirm.clean_names_note': '\n\n（仅处理尚未清理的名称。）',
    'msg.no_names_to_clean': '没有需要清理的名称。',
    'msg.all_clean_already': '所有名称已经清理（{total}/{total}）。',
    'msg.force_clean_question': '是否重新处理所有名称（在提示语改进后很有用）？',
    'job.status_label': '[{status}] {done}/{total}（{errors} 个错误）',

    // 分组
    'groups.title': '分组',
    'groups.help': '将您的 CSV 导入组织到不同的项目中。每个分组都会自动保存，以便日后访问。',
    'groups.all_salons': '所有沙龙',
    'groups.without_group': '未分组的沙龙',
    'groups.orphan_help': '这些沙龙未分配到任何分组。创建一个分组并通过来源筛选器进行分配。',
    'groups.new': '新建分组',
    'groups.rename': '重命名',
    'groups.rename_tooltip': '重命名此分组',
    'groups.delete': '删除',
    'groups.delete_tooltip': '删除此分组（沙龙仍保留在数据库中）',
    'groups.salons_label': '沙龙',
    'groups.sources_label': 'CSV 导入',
    'groups.import_no_group': '— 无分组（默认）—',
    'groups.prompt_new_name': '新分组的名称：',
    'groups.prompt_new_description': '描述（可选）：',
    'groups.prompt_rename': '分组的新名称：',
    'groups.confirm_delete': '删除分组 "{name}"？\n\n其中包含的 {count} 个沙龙不会被删除——它们将回到"未分组的沙龙"。',

    // 批量操作
    'bulk.count_label': '{count} 个沙龙符合当前筛选条件',
    'bulk.move': '移动',
    'bulk.delete': '删除',
    'bulk.choose_target': '— 选择目标分组 —',
    'bulk.target_no_group': '从分组中移除（变为"未分组"）',
    'bulk.confirm_move': '将 {count} 个沙龙移动到 "{target}"？',
    'bulk.moved_success': '已成功移动 {count} 个沙龙。',
    'bulk.confirm_delete_1': '永久删除 {count} 个沙龙？\n\n此操作无法撤销 — 所有数据、截图和自定义内容都将丢失。',
    'bulk.confirm_delete_2': '确定吗？点击"确定"以确认永久删除。',
    'bulk.deleted_success': '已删除 {count} 个沙龙。',

    'err.generic': '错误',
    'err.empty_field': '空',
    'err.saving': '…'
  }
};

// Detection lang : prefere localStorage > defaut FR.
// L'outil est destiné à l'agence FR ; on ne se base PLUS sur navigator.language
// car même un user FR peut avoir Chrome en EN (cas observé en test). Si l'user
// veut EN ou ZH, il clique le sélecteur — son choix est persisté en localStorage.
function detectLang() {
  const stored = localStorage.getItem('outil-coiffure-lang');
  if (stored && TRANSLATIONS[stored]) return stored;
  return 'fr';
}

let currentLang = detectLang();

export function getCurrentLang() { return currentLang; }

export function setLang(lang) {
  if (!TRANSLATIONS[lang]) return;
  currentLang = lang;
  localStorage.setItem('outil-coiffure-lang', lang);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  applyTranslations();
}

export function t(key, params = {}) {
  const dict = TRANSLATIONS[currentLang] || TRANSLATIONS.fr;
  let s = dict[key] ?? TRANSLATIONS.fr[key] ?? key;
  for (const [k, v] of Object.entries(params)) {
    s = s.replace(`{${k}}`, v);
  }
  return s;
}

// Applique les traductions a tous les elements [data-i18n] et [data-i18n-attr]
export function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  // Attributs (placeholder, title, aria-label)
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
  // Mise a jour du <title> si la page en a un attribut data
  if (document.body.dataset.i18nTitle) {
    document.title = t(document.body.dataset.i18nTitle);
  }
  // Update active state of language buttons
  document.querySelectorAll('.lang-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === currentLang);
  });
  // Re-render dynamic content if a callback is registered
  if (window.onLangChange) window.onLangChange();
}

// Initialisation
document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : currentLang;
