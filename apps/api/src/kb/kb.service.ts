import { Inject, Injectable } from "@nestjs/common";
import { sql } from "@orbyt/db";
import { DbService } from "../db.service";
import type { Scope } from "../scope";

// shortcut: English only. Without stop words every question matches every document through "are",
// "the", "you"... Other languages still work, just with noisier ranking.
const STOP_WORDS = new Set(
  (
    "the and are you your what when how can for with this that have has from was were will would could " +
    "should does did not but all any our out who why where which there their them they about into than " +
    "then also get got its his her she him let may might much many most more some such too very yes"
  ).split(" "),
);

export interface KbHit {
  id: string;
  title: string;
  body: string;
}

/**
 * Retrieval over the workspace's knowledge-base documents with Postgres full-text search.
 * shortcut: keyword search (any of the question's words, ranked), no embeddings and no chunking:
 * the best few documents are passed whole (truncated). Upgrade to pgvector + chunking when the
 * knowledge base grows past a few hundred short documents or questions are paraphrased heavily.
 */
@Injectable()
export class KbService {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  async search(scope: Scope, text: string, limit = 3): Promise<KbHit[]> {
    // Only letters and digits reach the tsquery, so user text can never inject query operators.
    // `:*` matches word beginnings, so "refund" finds "refunds" and "ship" finds "shipping".
    const words = [
      ...new Set(
        (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
          (w) => !STOP_WORDS.has(w),
        ),
      ),
    ].slice(0, 12);
    if (words.length === 0) return [];
    const query = words.map((w) => `${w}:*`).join(" | ");
    return this.dbs.inWorkspace(scope, async (tx) => {
      const res = await tx.execute(sql`
        select d.id, d.title, d.body
        from kb_documents d, to_tsquery('simple', ${query}) q
        where d.search @@ q
        order by ts_rank(d.search, q) desc
        limit ${limit}`);
      return res.rows as unknown as KbHit[];
    });
  }
}
