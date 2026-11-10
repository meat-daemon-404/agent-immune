import { insertAntibody } from './antibodies.js';
export function installSeedPack(db, pack, rules) {
    const report = { pack, inserted: 0, alreadySeeded: 0 };
    const now = Date.now();
    const tx = db.prepare('BEGIN');
    try {
        tx.run();
        for (const rule of rules) {
            const recorded = db
                .prepare('SELECT rule_id FROM seed_packs WHERE pack = ? AND prescription = ?')
                .get(pack, rule.prescription.trim().slice(0, 200));
            if (recorded) {
                report.alreadySeeded += 1;
                continue;
            }
            const id = insertAntibody(db, rule);
            if (id === null)
                continue;
            db.prepare('INSERT INTO seed_packs (rule_id, pack, prescription, seeded_at) VALUES (?, ?, ?, ?)').run(id, pack, rule.prescription.trim().slice(0, 200), now);
            report.inserted += 1;
        }
        db.prepare('COMMIT').run();
    }
    catch (error) {
        db.prepare('ROLLBACK').run();
        throw error;
    }
    return report;
}
export function removeSeedPack(db, pack) {
    const report = { pack, removed: 0, keptChanged: 0, keptProven: 0 };
    const rows = db
        .prepare('SELECT rule_id, prescription FROM seed_packs WHERE pack = ?')
        .all(pack);
    const tx = db.prepare('BEGIN');
    try {
        tx.run();
        for (const row of rows) {
            const current = db
                .prepare('SELECT prescription, hit_count FROM antibodies WHERE id = ?')
                .get(row.rule_id);
            if (!current) {
                // The rule is gone (user pruned it); just drop the marker.
                db.prepare('DELETE FROM seed_packs WHERE rule_id = ?').run(row.rule_id);
                continue;
            }
            if (current.prescription !== row.prescription) {
                // The rule changed since seeding — it carries the user's evidence now.
                report.keptChanged += 1;
                continue;
            }
            if (current.hit_count > 0) {
                // The rule has been delivered and (so far) held — removing proven
                // advice would discard the user's own counter-evidence trail.
                report.keptProven += 1;
                continue;
            }
            db.prepare('DELETE FROM antibodies WHERE id = ?').run(row.rule_id);
            db.prepare('DELETE FROM seed_packs WHERE rule_id = ?').run(row.rule_id);
            report.removed += 1;
        }
        db.prepare('COMMIT').run();
    }
    catch (error) {
        db.prepare('ROLLBACK').run();
        throw error;
    }
    return report;
}
/** Per-pack counts of still-recorded seed rows, for the list view. */
export function seededPackCounts(db) {
    const rows = db
        .prepare('SELECT pack, COUNT(*) AS n FROM seed_packs GROUP BY pack')
        .all();
    return new Map(rows.map((row) => [row.pack, row.n]));
}
