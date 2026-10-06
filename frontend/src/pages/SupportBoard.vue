<script setup lang="ts">
/**
 * /supports 支撑加固与避雷件登记
 * 每次检查单独登记一条记录（检查日期 / 检查人 / 检查结论）；
 * 超期提示与下次检查日期以最新一条检查记录为准，未登记过检查的按未检查提示。
 * 消费模型：Support、SupportCheck、Tree；复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>、<VigorTag>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import VigorTag from '@/components/common/VigorTag.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useTreeStore } from '@/stores/treeStore'
import { addSupportCheck, db, removeSupport } from '@/utils/db'
import { SUPPORT_TYPE_OPTIONS, type Support, type SupportCheck, type SupportDraft, type SupportType } from '@/types/support'
import {
  isSupportOverdue,
  latestSupportCheck,
  nextCheckDate,
  overdueDays,
  supportCheckState,
} from '@/utils/dimension'
import { today } from '@/utils/id'

const treeStore = useTreeStore()

const { rows, loading, create, update } = useIdbTable<Support>(db.supports, { sortByUpdatedAt: false })
const { rows: checkRows, remove: removeCheckRow } = useIdbTable<SupportCheck>(db.supportChecks, {
  sortByUpdatedAt: false,
})

const keyword = ref('')
const treeFilter = ref('all')
const typeFilter = ref<SupportType | 'all'>('all')
const overdueOnly = ref(false)

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

const form = reactive<SupportDraft>({
  treeId: '',
  type: '支撑杆',
  installDate: '',
  checkCycleMon: 12,
})

const rules: FormRules<SupportDraft> = {
  treeId: [{ required: true, message: '请选择古树', trigger: 'change' }],
  type: [{ required: true, message: '请选择加固件类型', trigger: 'change' }],
  installDate: [{ required: true, message: '请选择安装日期', trigger: 'change' }],
  checkCycleMon: [{ required: true, message: '请填写检查周期', trigger: 'blur' }],
}

/* ------------------------------ 检查登记弹窗 ------------------------------ */

const checkDialogVisible = ref(false)
const checkSubmitting = ref(false)
const checkTargetId = ref<string | null>(null)
const checkFormRef = ref<FormInstance>()

const checkForm = reactive<{ date: string; inspector: string; conclusion: string }>({
  date: today(),
  inspector: '',
  conclusion: '',
})

const checkRules: FormRules<typeof checkForm> = {
  date: [{ required: true, message: '请选择检查日期', trigger: 'change' }],
  inspector: [{ required: true, message: '请填写检查人', trigger: 'blur' }],
  conclusion: [{ required: true, message: '请填写检查结论', trigger: 'blur' }],
}

/* ------------------------------ 检查记录弹窗 ------------------------------ */

const historyDialogVisible = ref(false)
const historyTargetId = ref<string | null>(null)

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

/** 按加固件聚合检查记录 */
const checksBySupport = computed<Map<string, SupportCheck[]>>(() => {
  const grouped = new Map<string, SupportCheck[]>()
  checkRows.value.forEach((check) => {
    const list = grouped.get(check.supportId)
    if (list === undefined) grouped.set(check.supportId, [check])
    else list.push(check)
  })
  return grouped
})

/** 某件加固件的检查记录：日期倒序，同日按录入时间倒序（后录的在前） */
function checksOf(supportId: string): SupportCheck[] {
  return [...(checksBySupport.value.get(supportId) ?? [])].sort(
    (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
  )
}

/** 最新一条检查记录；同一天补记多条以后录的那条为准 */
function latestCheckOf(supportId: string): SupportCheck | null {
  return latestSupportCheck(checksBySupport.value.get(supportId) ?? [])
}

function latestDateOf(row: Support): string {
  return latestCheckOf(row.id)?.date ?? ''
}

const filtered = computed<Support[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return rows.value
    .filter((row) => {
      if (treeFilter.value !== 'all' && row.treeId !== treeFilter.value) return false
      if (typeFilter.value !== 'all' && row.type !== typeFilter.value) return false
      const latest = latestCheckOf(row.id)
      if (overdueOnly.value && !isSupportOverdue(latest?.date ?? '', row.checkCycleMon)) return false
      if (key === '') return true
      return (
        (treeLabel.value[row.treeId] ?? '').toLowerCase().includes(key) ||
        row.type.toLowerCase().includes(key) ||
        (latest?.date ?? '').includes(key) ||
        (latest?.inspector ?? '').toLowerCase().includes(key) ||
        (latest?.conclusion ?? '').toLowerCase().includes(key)
      )
    })
    .sort((a, b) => a.installDate.localeCompare(b.installDate))
})

const overdueRows = computed<Support[]>(() =>
  rows.value.filter((row) => isSupportOverdue(latestDateOf(row), row.checkCycleMon))
)

const coveredTrees = computed<number>(() => new Set(rows.value.map((row) => row.treeId)).size)

const historyTarget = computed<Support | null>(
  () => rows.value.find((row) => row.id === historyTargetId.value) ?? null,
)

const historyChecks = computed<SupportCheck[]>(() =>
  historyTargetId.value === null ? [] : checksOf(historyTargetId.value)
)

const checkTarget = computed<Support | null>(
  () => rows.value.find((row) => row.id === checkTargetId.value) ?? null,
)

onMounted(() => {
  void treeStore.loadAll()
})

function rowClassName({ row }: { row: Support }): string {
  return isSupportOverdue(latestDateOf(row), row.checkCycleMon) ? 'row-overdue' : ''
}

/* ------------------------------ 加固件增删改 ------------------------------ */

function openCreate(): void {
  const treeId =
    treeFilter.value !== 'all' ? treeFilter.value : (treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? '')
  editingId.value = null
  Object.assign(form, {
    treeId,
    type: '支撑杆' as SupportType,
    installDate: today(),
    checkCycleMon: 12,
  })
  dialogVisible.value = true
}

function openEdit(row: Support): void {
  editingId.value = row.id
  Object.assign(form, {
    treeId: row.treeId,
    type: row.type,
    installDate: row.installDate,
    checkCycleMon: row.checkCycleMon,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value === null) {
      await create({ ...form }, 'support')
      ElMessage.success('加固件已登记，请登记首次检查记录')
    } else {
      await update(editingId.value, { ...form })
      ElMessage.success('加固件已更新')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Support): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除「${row.type}」加固件及其全部 ${checksOf(row.id).length} 条检查记录？`,
      '删除确认',
      {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消',
      },
    )
  } catch {
    return
  }
  await removeSupport(row.id)
  ElMessage.success('加固件及检查记录已删除')
}

/* ------------------------------ 检查登记 ------------------------------ */

function openCheckDialog(row: Support): void {
  checkTargetId.value = row.id
  Object.assign(checkForm, { date: today(), inspector: '', conclusion: '' })
  checkDialogVisible.value = true
}

async function handleCheckSubmit(): Promise<void> {
  if (checkFormRef.value === undefined || checkTargetId.value === null) return
  const valid = await checkFormRef.value.validate().catch(() => false)
  if (!valid) return
  checkSubmitting.value = true
  try {
    await addSupportCheck({
      supportId: checkTargetId.value,
      date: checkForm.date,
      inspector: checkForm.inspector.trim(),
      conclusion: checkForm.conclusion.trim(),
    })
    ElMessage.success(`已登记 ${checkForm.date} 的检查记录`)
    checkDialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    checkSubmitting.value = false
  }
}

/* ------------------------------ 检查记录 ------------------------------ */

function openHistory(row: Support): void {
  historyTargetId.value = row.id
  historyDialogVisible.value = true
}

async function handleDeleteCheck(check: SupportCheck): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除 ${check.date}（检查人：${check.inspector || '未登记'}）的检查记录？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await removeCheckRow(check.id)
  ElMessage.success('检查记录已删除，超期提示已按剩余最新记录重算')
}

function overdueText(row: Support): string {
  const latestDate = latestDateOf(row)
  if (latestDate === '') return '从未登记检查'
  return `最近检查 ${latestDate}，检查周期 ${row.checkCycleMon} 个月，已超期 ${overdueDays(latestDate, row.checkCycleMon)} 天`
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'treeId') treeFilter.value = value
  if (key === 'type') typeFilter.value = value as SupportType | 'all'
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="加固件总数" :value="rows.length" suffix="件" tone="primary" icon="Histogram" />
      <StatBadge
        label="超期未检查"
        :value="overdueRows.length"
        suffix="件"
        :tone="overdueRows.length > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="从未登记检查或超过检查周期（月）未再检查的加固件"
      />
      <StatBadge label="检查记录" :value="checkRows.length" suffix="条" tone="info" icon="DocumentChecked" />
      <StatBadge label="覆盖古树" :value="coveredTrees" suffix="株" tone="info" icon="DataLine" />
      <StatBadge label="筛选结果" :value="filtered.length" suffix="件" tone="default" icon="PieChart" size="small" />
    </div>

    <el-alert
      v-if="overdueRows.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${overdueRows.length} 件加固件超过检查周期未检查（含从未登记检查）`"
    >
      <template #default>
        <div class="overdue-list">
          <div v-for="row in overdueRows" :key="row.id">
            {{ treeLabel[row.treeId] ?? '（古树已删除）' }} · {{ row.type }}：{{ overdueText(row) }}
          </div>
        </div>
      </template>
    </el-alert>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">支撑加固与避雷件登记</span>
          <el-button type="primary" @click="openCreate" :disabled="treeStore.trees.length === 0">
            <el-icon><Plus /></el-icon>
            <span>登记加固件</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="keyword"
        :fields="[
          {
            key: 'treeId',
            label: '古树',
            options: treeStore.trees.map((tree) => tree.id),
            optionLabels: treeLabel,
          },
          { key: 'type', label: '类型', options: SUPPORT_TYPE_OPTIONS as unknown as string[] },
        ]"
        :values="{ treeId: treeFilter, type: typeFilter }"
        :result-text="`命中 ${filtered.length} / ${rows.length} 件`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="handleFilterChange"
        @reset="
          () => {
            keyword = ''
            treeFilter = 'all'
            typeFilter = 'all'
            overdueOnly = false
          }
        "
      >
        <template #extra>
          <el-checkbox v-model="overdueOnly" border size="small">只看超期 / 未检查</el-checkbox>
        </template>
      </FilterBar>

      <EmptyPanel
        v-if="rows.length === 0 && !loading"
        title="还没有加固件记录"
        description="登记支撑杆、拉纤与避雷件，设置检查周期后，每次检查单独登记，系统按最新检查记录自动高亮超期件并生成提醒。"
        action-text="登记第一件加固件"
        @action="openCreate"
      />

      <el-table
        v-else
        v-loading="loading || !treeStore.ready"
        :data="filtered"
        row-key="id"
        stripe
        :row-class-name="rowClassName"
      >
        <el-table-column label="古树" min-width="180">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ treeLabel[row.treeId] ?? '（古树已删除）' }}</span>
              <VigorTag
                :vigor="treeStore.statOf(row.treeId).latestVigor"
                :trend="treeStore.statOf(row.treeId).latestTrend"
                size="small"
              />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="row.type === '避雷' ? 'warning' : row.type === '拉纤' ? 'info' : 'success'">
              {{ row.type }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="installDate" label="安装日期" width="110" />
        <el-table-column label="检查周期" width="100" align="right">
          <template #default="{ row }">{{ row.checkCycleMon }} 个月</template>
        </el-table-column>
        <el-table-column label="检查次数" width="100" align="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openHistory(row)">
              {{ checksOf(row.id).length }} 次
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="最近检查（日期 / 检查人 / 结论）" min-width="240">
          <template #default="{ row }">
            <div v-if="latestCheckOf(row.id) === null" class="cell-warn">未检查</div>
            <div v-else class="cell-stack">
              <span>{{ latestCheckOf(row.id)?.date }} · {{ latestCheckOf(row.id)?.inspector || '检查人未登记' }}</span>
              <span class="cell-sub cell-ellipsis" :title="latestCheckOf(row.id)?.conclusion">
                {{ latestCheckOf(row.id)?.conclusion || '未填写结论' }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="下次检查" width="120">
          <template #default="{ row }">{{ nextCheckDate(latestDateOf(row), row.checkCycleMon) || '—' }}</template>
        </el-table-column>
        <el-table-column label="检查状态" width="150">
          <template #default="{ row }">
            <el-tag v-if="supportCheckState(latestDateOf(row), row.checkCycleMon) === 'unchecked'" type="warning" effect="dark">
              未检查
            </el-tag>
            <el-tag
              v-else-if="isSupportOverdue(latestDateOf(row), row.checkCycleMon)"
              type="danger"
              effect="dark"
            >
              超期 {{ overdueDays(latestDateOf(row), row.checkCycleMon) }} 天
            </el-tag>
            <el-tag v-else type="success" effect="light">周期内</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="330" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              :type="isSupportOverdue(latestDateOf(row), row.checkCycleMon) ? 'danger' : 'primary'"
              size="small"
              @click="openCheckDialog(row)"
            >
              登记检查
            </el-button>
            <el-button link type="primary" size="small" @click="openHistory(row)">检查记录</el-button>
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 加固件新建 / 编辑 -->
    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记加固件' : '编辑加固件'" width="600px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item label="古树" prop="treeId">
          <el-select v-model="form.treeId" filterable style="width: 100%">
            <el-option
              v-for="tree in treeStore.trees"
              :key="tree.id"
              :value="tree.id"
              :label="`${tree.code} · ${tree.species} · ${tree.location}`"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="类型" prop="type">
              <el-select v-model="form.type" style="width: 100%">
                <el-option v-for="item in SUPPORT_TYPE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="安装日期" prop="installDate">
              <el-date-picker v-model="form.installDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="检查周期（月）" prop="checkCycleMon">
          <el-input-number v-model="form.checkCycleMon" :min="1" :max="120" :step="1" style="width: 100%" />
        </el-form-item>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="检查记录按次单独登记"
          description="保存后请使用列表中的「登记检查」逐条记录检查日期、检查人与检查结论；超期提示与下次检查日期以最新一条检查记录为准，未登记检查前按未检查提示。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 登记一次检查 -->
    <el-dialog v-model="checkDialogVisible" title="登记加固件检查" width="560px">
      <el-form ref="checkFormRef" :model="checkForm" :rules="checkRules" label-width="100px">
        <el-form-item label="加固件">
          <span class="cell-sub">
            {{ checkTarget ? `${treeLabel[checkTarget.treeId] ?? '（古树已删除）'} · ${checkTarget.type}` : '' }}
          </span>
        </el-form-item>
        <el-form-item label="检查日期" prop="date">
          <el-date-picker v-model="checkForm.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="检查人" prop="inspector">
          <el-input v-model="checkForm.inspector" placeholder="如：王建军" maxlength="32" />
        </el-form-item>
        <el-form-item label="检查结论" prop="conclusion">
          <el-input
            v-model="checkForm.conclusion"
            type="textarea"
            :rows="3"
            placeholder="如：杆件牢固、焊缝无锈蚀，检查合格；发现问题请写明整改要求。"
          />
        </el-form-item>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          :title="`据此条记录，下次检查日期：${
            checkTarget ? nextCheckDate(checkForm.date, checkTarget.checkCycleMon) : '—'
          }`"
          description="每次检查都会单独保存为一条记录；同一天补记多条时，以最后录入的那条作为最新检查。"
        />
      </el-form>
      <template #footer>
        <el-button @click="checkDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="checkSubmitting" @click="handleCheckSubmit">保存检查记录</el-button>
      </template>
    </el-dialog>

    <!-- 检查记录历史 -->
    <el-dialog
      v-model="historyDialogVisible"
      :title="
        historyTarget
          ? `检查记录 · ${treeLabel[historyTarget.treeId] ?? '（古树已删除）'} ${historyTarget.type}（${historyChecks.length} 次）`
          : '检查记录'
      "
      width="720px"
    >
      <div class="history-toolbar">
        <el-button
          type="primary"
          size="small"
          :disabled="historyTarget === null"
          @click="historyTarget && openCheckDialog(historyTarget)"
        >
          <el-icon><Plus /></el-icon>
          <span>补记检查</span>
        </el-button>
      </div>
      <el-empty v-if="historyChecks.length === 0" description="还没有检查记录，未登记检查的加固件按超期提示" />
      <el-table v-else :data="historyChecks" row-key="id" stripe size="small">
        <el-table-column prop="date" label="检查日期" width="110" />
        <el-table-column prop="inspector" label="检查人" width="110">
          <template #default="{ row }">{{ row.inspector || '—' }}</template>
        </el-table-column>
        <el-table-column label="检查结论" min-width="240">
          <template #default="{ row }">{{ row.conclusion || '—' }}</template>
        </el-table-column>
        <el-table-column label="录入时间" width="160">
          <template #default="{ row }">{{ row.createdAt.replace('T', ' ').slice(0, 16) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-button link type="danger" size="small" @click="handleDeleteCheck(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-alert
        v-if="historyTarget"
        type="info"
        show-icon
        :closable="false"
        class="mt-12"
        :title="
          historyChecks.length === 0
            ? '该加固件尚未登记检查'
            : `当前以最新一条（${historyChecks[0].date} · ${historyChecks[0].inspector || '检查人未登记'}）判定超期与下次检查日期`
        "
      />
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #2f2a24;
}

.overdue-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-sub {
  font-size: 12px;
  color: #8c8479;
}

.cell-ellipsis {
  max-width: 240px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.cell-warn {
  color: #c0392b;
  font-weight: 600;
}

.history-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 10px;
}

.mb-14 {
  margin-bottom: 14px;
}

.mt-12 {
  margin-top: 12px;
}

:deep(.row-overdue) {
  --el-table-tr-bg-color: #fdf3f2;
}
</style>
