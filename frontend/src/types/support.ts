/**
 * 加固件（Support）
 * 支撑杆、拉纤、避雷设施，按检查周期自动提示超期未检查。
 */

/** 加固件类型 */
export type SupportType = '支撑杆' | '拉纤' | '避雷'

export const SUPPORT_TYPE_OPTIONS: SupportType[] = ['支撑杆', '拉纤', '避雷']

export interface Support {
  id: string
  /** 所属古树 */
  treeId: string
  /** 类型 */
  type: SupportType
  /** 安装日期 YYYY-MM-DD */
  installDate: string
  /** 检查周期（月） */
  checkCycleMon: number
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑加固件的表单草稿 */
export interface SupportDraft {
  treeId: string
  type: SupportType
  installDate: string
  checkCycleMon: number
}

/**
 * 加固件检查记录（SupportCheck）
 * 每次检查单独一条：检查日期、检查人、检查结论；
 * 超期提示与下次检查日期均以最新一条（日期相同时以后录入的为准）为准。
 */
export interface SupportCheck {
  id: string
  /** 所属加固件 */
  supportId: string
  /** 检查日期 YYYY-MM-DD */
  date: string
  /** 检查人 */
  inspector: string
  /** 检查结论 */
  conclusion: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 登记检查的表单草稿 */
export interface SupportCheckDraft {
  supportId: string
  date: string
  inspector: string
  conclusion: string
}
