// Wrapper CLI autour de src/contacted-import.js.
//
//   node scripts/import-contacted.js --dry-run   # rapport, n'écrit rien
//   node scripts/import-contacted.js             # applique
//   node scripts/import-contacted.js autre.csv   # seed alternatif
//
// En production (conteneur Coolify sans accès SSH) le même import se déclenche
// depuis le dashboard : CSV → « Historique cold-mail » → Prévisualiser / Importer.
import { runContactedImport, DEFAULT_SEED } from '../src/contacted-import.js';

const dryRun = process.argv.includes('--dry-run');
const seedPath = process.argv.find(a => a.endsWith('.csv')) || DEFAULT_SEED;

const s = runContactedImport({ dryRun, seedPath });

console.log(`Seed : ${s.seed} lignes (${seedPath})`);
console.log(`  matché par slug  : ${s.matchedBySlug}`);
console.log(`  matché par email : ${s.matchedByEmail}`);
console.log(`  introuvable      : ${s.missed}`);
console.log(`  dont date exacte : ${s.withDate}`);
if (s.missedSamples.length) console.log(`  exemples introuvables : ${s.missedSamples.join(', ')}`);
console.log(`Taux de matching : ${s.matchRate}%`);

if (s.dryRun) {
  console.log('\n--dry-run : rien écrit.');
} else {
  console.log(`\n${s.applied} salons marqués comme contactés.`);
}
console.log(`Base : ${s.contacted} contactés / ${s.totalSalons} salons → ${s.neverContacted} jamais contactés.`);
