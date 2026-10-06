/**
 * 导出工具：整库 JSON 存档、古树档案 CSV、复评结论文本
 * 全部在浏览器本地完成，不经过任何服务端。
 */
import type { DatabaseSnapshot } from './db'
import { DB_NAME, DB_SCHEMA_VERSION } from './db'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure } from '../types/measure'
import type { Support, SupportCheck } from '../types/support'
import type { Review } from '../types/review'
import { stampSuffix } from './id'
import { isSupportOverdue, latestSupportCheck, overdueDays } from './dimension'

/** 触发浏览器下载 */
export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** CSV 单元格转义 */
export function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 导出整库 JSON 存档，返回文件名 */
export function exportSnapshotJson(snapshot: DatabaseSnapshot): string {
  const filename = `${DB_NAME}-backup-${stampSuffix()}.json`
  download(filename, JSON.stringify(snapshot, null, 2), 'application/json;charset=utf-8')
  return filename
}

export interface SnapshotParseResult {
  ok: boolean
  message: string
  snapshot: DatabaseSnapshot | null
}

/** 解析并校验导入的 JSON 存档 */
export function parseSnapshot(text: string): SnapshotParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, message: 'JSON 解析失败，请确认文件内容完整。', snapshot: null }
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '存档格式不正确：顶层必须是对象。', snapshot: null }
  }
  const data = raw as Partial<DatabaseSnapshot>
  if (data.name !== DB_NAME) {
    return { ok: false, message: `存档不属于本项目：期望 name = ${DB_NAME}，实际为 ${String(data.name)}。`, snapshot: null }
  }
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion > DB_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `存档数据结构版本不兼容：当前支持 ≤ v${DB_SCHEMA_VERSION}，实际为 v${String(data.schemaVersion)}。`,
      snapshot: null,
    }
  }
  const collections: Array<keyof DatabaseSnapshot> = ['trees', 'surveys', 'measures', 'supports', 'supportChecks', 'reviews']
  for (const key of collections) {
    if (!Array.isArray(data[key])) {
      // 兼容旧版（v2 及以前）存档：当时加固件检查记录尚未独立成表
      if (key === 'supportChecks') {
        data.supportChecks = []
        continue
      }
      return { ok: false, message: `存档缺少 ${String(key)} 数组。`, snapshot: null }
    }
  }
  return { ok: true, message: '存档校验通过。', snapshot: data as DatabaseSnapshot }
}

/** 按加固件聚合检查记录（用于以最新检查记录派生超期） */
function groupSupportChecks(supportChecks: SupportCheck[]): Map<string, SupportCheck[]> {
  const grouped = new Map<string, SupportCheck[]>()
  supportChecks.forEach((check) => {
    const list = grouped.get(check.supportId)
    if (list === undefined) grouped.set(check.supportId, [check])
    else list.push(check)
  })
  return grouped
}

/** 生成古树养护总览 CSV（一树一行） */
export function buildTreeCsv(
  trees: Tree[],
  surveys: Survey[],
  measures: Measure[],
  supports: Support[],
  reviews: Review[],
  supportChecks: SupportCheck[] = [],
): string {
  const header = [
    '编号',
    '树种',
    '保护级别',
    '树龄(年)',
    '位置',
    '管护单位',
    '检查次数',
    '最近检查日期',
    '树高(m)',
    '胸径(cm)',
    '冠幅(m)',
    '倾斜度(度)',
    '空洞数',
    '立地状况',
    '措施总数',
    '已完成措施',
    '最近复壮日期',
    '加固件数',
    '加固检查次数',
    '超期未检查',
    '复评次数',
    '最新长势',
    '最新趋势',
  ]
  const lines: string[] = [header.map(csvCell).join(',')]
  const checksBySupport = groupSupportChecks(supportChecks)
  trees.forEach((tree) => {
    const treeSurveys = surveys.filter((row) => row.treeId === tree.id).sort((a, b) => a.date.localeCompare(b.date))
    const latest = treeSurveys.length > 0 ? treeSurveys[treeSurveys.length - 1] : null
    const treeMeasures = measures.filter((row) => row.treeId === tree.id)
    const treeSupports = supports.filter((row) => row.treeId === tree.id)
    const treeReviews = reviews.filter((row) => row.treeId === tree.id).sort((a, b) => a.date.localeCompare(b.date))
    const latestReview = treeReviews.length > 0 ? treeReviews[treeReviews.length - 1] : null
    const treeCheckCount = treeSupports.reduce(
      (acc, row) => acc + (checksBySupport.get(row.id)?.length ?? 0),
      0,
    )
    const overdue = treeSupports.filter((row) => {
      const latestCheckDate = latestSupportCheck(checksBySupport.get(row.id) ?? [])?.date ?? ''
      return isSupportOverdue(latestCheckDate, row.checkCycleMon)
    })
    lines.push(
      [
        tree.code,
        tree.species,
        tree.protectLevel,
        tree.ageYears,
        tree.location,
        tree.owner,
        treeSurveys.length,
        latest === null ? '—' : latest.date,
        latest === null ? 0 : latest.heightM,
        latest === null ? 0 : latest.dbhCm,
        latest === null ? 0 : latest.crownM,
        latest === null ? 0 : latest.leanDeg,
        latest === null ? 0 : latest.hollowCount,
        latest === null ? '—' : latest.siteNote,
        treeMeasures.length,
        treeMeasures.filter((row) => row.state === '已完成').length,
        tree.lastMeasureDate === '' ? '—' : tree.lastMeasureDate,
        treeSupports.length,
        treeCheckCount,
        overdue.length === 0
          ? '无'
          : overdue
              .map((row) => {
                const latestCheckDate = latestSupportCheck(checksBySupport.get(row.id) ?? [])?.date ?? ''
                return latestCheckDate === ''
                  ? `${row.type}未检查`
                  : `${row.type}超期 ${overdueDays(latestCheckDate, row.checkCycleMon)} 天`
              })
              .join('；'),
        treeReviews.length,
        latestReview === null ? '—' : latestReview.vigor,
        latestReview === null ? '—' : latestReview.trend,
      ]
        .map(csvCell)
        .join(','),
    )
  })
  return `\uFEFF${lines.join('\n')}`
}

/** 导出古树养护总览 CSV 文件 */
export function exportTreeCsvFile(
  trees: Tree[],
  surveys: Survey[],
  measures: Measure[],
  supports: Support[],
  reviews: Review[],
  supportChecks: SupportCheck[] = [],
): string {
  const filename = `古树名木养护总览-${stampSuffix()}.csv`
  download(
    filename,
    buildTreeCsv(trees, surveys, measures, supports, reviews, supportChecks),
    'text/csv;charset=utf-8',
  )
  return filename
}

/** 复制文本到剪贴板 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    return false
  }
  return false
}

/** 生成复评与复壮待办纯文本 */
export function buildTodoText(
  trees: Tree[],
  measures: Measure[],
  supports: Support[],
  reviews: Review[],
  supportChecks: SupportCheck[] = [],
): string {
  const lines: string[] = [`【古树名木复壮养护待办】共 ${trees.length} 株在档`]
  const checksBySupport = groupSupportChecks(supportChecks)
  trees.forEach((tree) => {
    const pending = measures.filter((row) => row.treeId === tree.id && row.state !== '已完成').length
    const treeSupports = supports.filter((row) => row.treeId === tree.id)
    let unchecked = 0
    let overdue = 0
    treeSupports.forEach((row) => {
      const latestCheckDate = latestSupportCheck(checksBySupport.get(row.id) ?? [])?.date ?? ''
      if (latestCheckDate === '') unchecked += 1
      else if (isSupportOverdue(latestCheckDate, row.checkCycleMon)) overdue += 1
    })
    const treeReviews = reviews.filter((row) => row.treeId === tree.id).sort((a, b) => a.date.localeCompare(b.date))
    const latest = treeReviews.length > 0 ? treeReviews[treeReviews.length - 1] : null
    const supportNote =
      unchecked > 0 && overdue > 0
        ? `超期/未检查加固件 ${unchecked + overdue} 件（其中未检查 ${unchecked} 件）`
        : unchecked > 0
          ? `未检查加固件 ${unchecked} 件`
          : `超期加固件 ${overdue} 件`
    lines.push(
      `· ${tree.code} ${tree.species}（${tree.protectLevel}，树龄 ${tree.ageYears} 年）待办措施 ${pending} 项，${supportNote}，最新长势 ${
        latest === null ? '未复评' : `${latest.vigor}（${latest.trend}）`
      }`,
    )
  })
  return lines.join('\n')
}
