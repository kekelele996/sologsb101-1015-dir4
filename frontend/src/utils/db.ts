/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree
 * - 含数据结构版本号与 v1 → v2 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState } from '../types/measure'
import type { Support, SupportCheck } from '../types/support'
import type { Review } from '../types/review'
import { nowIso, uuid } from './id'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbheritagetree'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 2

class HeritageTreeDatabase extends Dexie {
  trees!: Table<Tree, string>
  surveys!: Table<Survey, string>
  measures!: Table<Measure, string>
  supports!: Table<Support, string>
  supportChecks!: Table<SupportCheck, string>
  reviews!: Table<Review, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      trees: 'id, code, species, protectLevel, ageYears, createdAt',
      surveys: 'id, treeId, date',
      measures: 'id, treeId, type, state, date',
      supports: 'id, treeId, type, installDate',
      reviews: 'id, treeId, date, vigor',
    })

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        // 复合索引 [treeId+date]：按古树 + 日期快速取检查记录
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('trees'),
          tx.table('surveys'),
          tx.table('measures'),
          tx.table('supports'),
          tx.table('reviews'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：古树补齐「最近复壮日期」
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastMeasureDate !== 'string') row.lastMeasureDate = ''
        })
        // 迁移 3：复评补齐「后续措施」
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.followUp !== 'string') row.followUp = ''
        })
        // 迁移 4：加固件补齐「最近检查日期」
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastCheckDate !== 'string') row.lastCheckDate = ''
          if (typeof row.checkCycleMon !== 'number') row.checkCycleMon = 12
        })
      })

    // ---------- v3：加固件每次检查独立成表（supportChecks） ----------
    // supports 去掉 lastCheckDate 字段与索引；检查记录单独入 supportChecks，
    // 超期提示与下次检查日期一律以最新一条检查记录为准。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate',
        supportChecks: 'id, supportId, treeId, date',
        reviews: 'id, treeId, date, vigor, trend',
      })
      .upgrade(async (tx) => {
        // 把 v2 的「最近检查日期」迁移为首条历史检查记录（无检查人/结论，留空待补）。
        // 同一天补记多条以后录为准，迁移只产生一条，不影响该规则。
        const stamp = nowIso()
        const legacySupports = await tx.table<Support & { lastCheckDate?: string }, string>('supports').toArray()
        const migrated: SupportCheck[] = legacySupports
          .filter((row) => typeof row.lastCheckDate === 'string' && row.lastCheckDate !== '')
          .map((row) => ({
            id: uuid('supportcheck'),
            supportId: row.id,
            treeId: row.treeId,
            date: row.lastCheckDate as string,
            inspector: '',
            conclusion: '历史数据迁移（原最近检查日期）',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          }))
        if (migrated.length > 0) {
          await tx.table('supportChecks').bulkPut(migrated)
        }
        // 加固件本体不再保存最近检查日期
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          delete row.lastCheckDate
        })
      })
  }
}

export const db = new HeritageTreeDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.trees.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 古树 -------------------------------- */

export async function listTrees(): Promise<Tree[]> {
  const rows = await db.trees.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function getTree(id: string): Promise<Tree | undefined> {
  return db.trees.get(id)
}

export async function putTree(row: Tree): Promise<void> {
  await db.trees.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除古树并级联清理其检查、措施、加固（含检查记录）与复评记录 */
export async function removeTree(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.supportChecks, db.reviews],
    async () => {
      const supportIds = (await db.supports.where('treeId').equals(id).primaryKeys()) as string[]
      await db.surveys.where('treeId').equals(id).delete()
      await db.measures.where('treeId').equals(id).delete()
      if (supportIds.length > 0) {
        await db.supportChecks.where('supportId').anyOf(supportIds).delete()
      }
      await db.supportChecks.where('treeId').equals(id).delete()
      await db.supports.where('treeId').equals(id).delete()
      await db.reviews.where('treeId').equals(id).delete()
      await db.trees.delete(id)
    },
  )
}

/* ------------------------------ 树体检查 ------------------------------ */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray()
  return rows.sort((a, b) => a.treeId.localeCompare(b.treeId) || a.date.localeCompare(b.date))
}

export async function listSurveysByTree(treeId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putSurvey(row: Survey): Promise<void> {
  await db.surveys.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id)
}

/* ------------------------------ 复壮措施 ------------------------------ */

export async function listMeasures(): Promise<Measure[]> {
  const rows = await db.measures.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listMeasuresByTree(treeId: string): Promise<Measure[]> {
  const rows = await db.measures.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * 写入复壮措施。
 * 措施状态为「已完成」时，回写古树的最近复壮日期（仅当本次日期更新时）。
 */
export async function putMeasure(row: Measure): Promise<void> {
  await db.transaction('rw', db.trees, db.measures, async () => {
    await db.measures.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
    if (row.state !== '已完成') return
    const tree = await db.trees.get(row.treeId)
    if (!tree) return
    if (tree.lastMeasureDate >= row.date) return
    await db.trees.update(tree.id, { lastMeasureDate: row.date, updatedAt: nowIso() })
  })
}

export async function removeMeasure(id: string): Promise<void> {
  await db.measures.delete(id)
}

/** 批量修改措施状态；改为「已完成」时同步回写古树最近复壮日期 */
export async function batchSetMeasureState(ids: string[], state: MeasureState): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db.measures.bulkGet(ids)
  const list = rows.filter((row): row is Measure => row !== undefined)
  for (const row of list) {
    await putMeasure({ ...row, state })
  }
  return list.length
}

/* ------------------------------ 加固件 ------------------------------ */

export async function listSupports(): Promise<Support[]> {
  const rows = await db.supports.toArray()
  return rows.sort((a, b) => a.installDate.localeCompare(b.installDate))
}

export async function listSupportsByTree(treeId: string): Promise<Support[]> {
  return db.supports.where('treeId').equals(treeId).toArray()
}

export async function putSupport(row: Support): Promise<void> {
  await db.supports.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除加固件并级联清理它的全部检查记录 */
export async function removeSupport(id: string): Promise<void> {
  await db.transaction('rw', db.supports, db.supportChecks, async () => {
    await db.supportChecks.where('supportId').equals(id).delete()
    await db.supports.delete(id)
  })
}

/* ------------------------------ 加固件检查 ------------------------------ */

export async function listSupportChecks(): Promise<SupportCheck[]> {
  return db.supportChecks.toArray()
}

export async function listSupportChecksBySupport(supportId: string): Promise<SupportCheck[]> {
  return db.supportChecks.where('supportId').equals(supportId).toArray()
}

export async function putSupportCheck(row: SupportCheck): Promise<void> {
  await db.supportChecks.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/**
 * 登记一次加固件检查：每次检查单独写入一条记录。
 * 同一天补记多条时，以录入时间（createdAt）更晚的那条作为最新检查。
 */
export async function addSupportCheck(input: {
  supportId: string
  date: string
  inspector: string
  conclusion: string
}): Promise<SupportCheck> {
  const support = await db.supports.get(input.supportId)
  if (!support) throw new Error('加固件不存在或已被删除')
  const stamp = nowIso()
  const record: SupportCheck = {
    id: uuid('supportcheck'),
    supportId: input.supportId,
    treeId: support.treeId,
    date: input.date,
    inspector: input.inspector,
    conclusion: input.conclusion,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  }
  await db.supportChecks.put(record)
  return record
}

export async function removeSupportCheck(id: string): Promise<void> {
  await db.supportChecks.delete(id)
}

/* ------------------------------ 长势复评 ------------------------------ */

export async function listReviews(): Promise<Review[]> {
  const rows = await db.reviews.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listReviewsByTree(treeId: string): Promise<Review[]> {
  const rows = await db.reviews.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReview(row: Review): Promise<void> {
  await db.reviews.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeReview(id: string): Promise<void> {
  await db.reviews.delete(id)
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  trees: Tree[]
  surveys: Survey[]
  measures: Measure[]
  supports: Support[]
  supportChecks: SupportCheck[]
  reviews: Review[]
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, supportChecks, reviews] = await Promise.all([
    db.trees.toArray(),
    db.surveys.toArray(),
    db.measures.toArray(),
    db.supports.toArray(),
    db.supportChecks.toArray(),
    db.reviews.toArray(),
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    trees,
    surveys,
    measures,
    supports,
    supportChecks,
    reviews,
  }
}

/** 用快照覆盖整库（导入存档）；兼容旧版无 supportChecks 数组的存档 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.supportChecks, db.reviews],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.supportChecks.clear(),
        db.reviews.clear(),
      ])
      await db.trees.bulkPut(snapshot.trees.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.measures.bulkPut(snapshot.measures.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.supports.bulkPut(snapshot.supports.map(stripLegacyLastCheck))
      const stamp = nowIso()
      // 兼容旧版（v2 及以前）存档：把 lastCheckDate 补成首条历史检查记录
      const legacyChecks: SupportCheck[] = snapshot.supports.flatMap((support) => {
        const legacyDate = (support as Support & { lastCheckDate?: string }).lastCheckDate
        if (typeof legacyDate !== 'string' || legacyDate === '') return []
        return [
          {
            id: uuid('supportcheck'),
            supportId: support.id,
            treeId: support.treeId,
            date: legacyDate,
            inspector: '',
            conclusion: '历史数据迁移（原最近检查日期）',
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          },
        ]
      })
      await db.supportChecks.bulkPut(
        [...snapshot.supportChecks.map((row) => ({ ...row, revision: ROW_REVISION })), ...legacyChecks],
      )
      await db.reviews.bulkPut(snapshot.reviews.map((row) => ({ ...row, revision: ROW_REVISION })))
    },
  )
}

/** 旧版（v2 及以前）加固件行带有 lastCheckDate，导入时剔除该冗余字段 */
function stripLegacyLastCheck(row: Support): Support {
  const legacy = row as Support & { lastCheckDate?: string }
  const { lastCheckDate: _legacy, ...rest } = legacy
  void _legacy
  return { ...rest, revision: ROW_REVISION }
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.supportChecks, db.reviews],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.supportChecks.clear(),
        db.reviews.clear(),
      ])
    },
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, supportChecks, reviews] = await Promise.all([
    db.trees.count(),
    db.surveys.count(),
    db.measures.count(),
    db.supports.count(),
    db.supportChecks.count(),
    db.reviews.count(),
  ])
  return { trees, surveys, measures, supports, supportChecks, reviews }
}
