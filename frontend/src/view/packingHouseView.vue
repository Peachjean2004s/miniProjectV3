<script setup>
import { ref, computed, onMounted } from 'vue'
import RecipientPicker from '@/components/RecipientPicker.vue'
import {txReceiveLot, txInitiateTransfer, txSplitLot,Status, hasPendingTransfer, parseContractError, formatLotId, assertWalletMatch} from '@/utils/blockchain'
import { fetchPendingLots, fetchOwnedLots, getDisplayNames, recordLotEvent } from '@/utils/api'

const walletAddress = ref('')
const activePage = ref('pending')
const isLoading = ref(false)

// ── Lots ──
const pending = ref([])
const inventory = ref([])
const displayNames = ref({})

// ── Confirm ──
const confirmSuccess = ref(null)
const confirmError = ref('')

// ── Split Lot (on-chain) ──
const splitParentId = ref(null)
const splitGrade = ref('A')
const splitWeight = ref('')
const splitSuccess = ref(null)
const splitError = ref('')
const isSplitting = ref(false)

// ── Transfer ──
const transferLotId = ref('')
const transferTo = ref('')
const transferSuccess = ref(null)
const transferError = ref('')
const isTransferring = ref(false)

onMounted(async () => {
  const stored = localStorage.getItem('walletAddress')
  if (stored) { walletAddress.value = stored; await refreshLots() }
})

async function refreshLots() {
  isLoading.value = true
  try {
    const [pend, inv] = await Promise.all([
      fetchPendingLots(walletAddress.value),
      fetchOwnedLots(walletAddress.value, [Status.ReceivedByPackingHouse]),
    ])
    pending.value = pend
    inventory.value = inv.filter(l => !hasPendingTransfer(l))
    const addrs = [...new Set(pend.map(l => l.currentOwner))]
    if (addrs.length) displayNames.value = await getDisplayNames(addrs)
  } catch (e) { console.error('refreshLots:', e) }
  finally { isLoading.value = false }
}

const shortAddress = (addr) => addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : ''
const displayFrom = (addr) => displayNames.value[addr] || shortAddress(addr)
const totalWeight = computed(() => inventory.value.reduce((s, i) => s + i.weightKg, 0))
// เฉพาะ lot ต้นทาง (parentLotId === 0) เท่านั้นที่ splitLot ได้
const splittableLots = computed(() => inventory.value.filter(l => l.parentLotId === 0))
const selectedParentWeight = computed(() =>
  inventory.value.find(l => l.lotId === splitParentId.value)?.weightKg || 0
)
const canSplit = computed(() =>
  splitParentId.value && splitGrade.value && splitWeight.value &&
  Number(splitWeight.value) > 0 && Number(splitWeight.value) <= selectedParentWeight.value
)
const canTransfer = computed(() =>
  transferLotId.value && transferTo.value.trim().startsWith('0x') && transferTo.value.trim().length === 42
)

// ── Actions ──
async function confirmReceipt(lotId) {
  confirmError.value = ''
  try {
    await assertWalletMatch(walletAddress.value)
    const { txHash, blockNumber, newStatus, timestamp } = await txReceiveLot(lotId)
    confirmSuccess.value = lotId
    await refreshLots()
    setTimeout(() => (confirmSuccess.value = null), 5000)
    recordLotEvent({ eventType: 'HandshakeCompleted', lotId, txHash, blockNumber, actorAddress: walletAddress.value, timestamp, lotData: { newStatus } })
  } catch (e) { confirmError.value = parseContractError(e) }
}

function startSplit(lotId) {
  splitParentId.value = lotId
  splitGrade.value = 'A'
  splitWeight.value = ''
  splitError.value = ''
  activePage.value = 'split'
}

async function handleSplitLot() {
  if (!canSplit.value) return
  isSplitting.value = true
  splitError.value = ''
  try {
    await assertWalletMatch(walletAddress.value)
    const parentId = splitParentId.value
    const parentLot = inventory.value.find(l => l.lotId === parentId)
    const { txHash, blockNumber, subLotId, timestamp } = await txSplitLot(parentId, splitGrade.value, Number(splitWeight.value))
    splitSuccess.value = subLotId
    splitParentId.value = null
    splitWeight.value = ''
    await refreshLots()
    activePage.value = 'inventory'
    setTimeout(() => (splitSuccess.value = null), 6000)
    recordLotEvent({
      eventType: 'LotSplit',
      lotId: subLotId,
      txHash, blockNumber,
      actorAddress: walletAddress.value,
      timestamp,
      lotData: {
        subLotId, parentLotId: parentId,
        variety: parentLot?.variety, weightKg: Number(splitWeight.value),
        orchardAddress: parentLot?.orchard,
      },
    })
  } catch (e) { splitError.value = parseContractError(e) }
  finally { isSplitting.value = false }
}

async function handleTransfer() {
  if (!canTransfer.value) return
  isTransferring.value = true
  transferError.value = ''
  try {
    await assertWalletMatch(walletAddress.value)
    const lotId = Number(transferLotId.value)
    const toAddr = transferTo.value.trim()
    const { txHash, blockNumber, timestamp } = await txInitiateTransfer(lotId, toAddr)
    transferSuccess.value = lotId
    transferLotId.value = ''
    transferTo.value = ''
    await refreshLots()
    setTimeout(() => (transferSuccess.value = null), 5000)
    recordLotEvent({ eventType: 'HandshakeInitiated', lotId, txHash, blockNumber, actorAddress: walletAddress.value, targetAddress: toAddr, timestamp })
  } catch (e) { transferError.value = parseContractError(e) }
  finally { isTransferring.value = false }
}

function disconnect() {
  localStorage.removeItem('walletAddress')
  localStorage.removeItem('userRole')
  window.location.href = '/'
}
</script>

<template>
  <div class="app">
    <div class="blob blob-green"></div>
    <div class="blob blob-peach"></div>

    <nav class="navbar">
      <span class="nav-brand">LONGAN TRACEABILITY</span>
      <div class="navbar-right">
        <div v-if="walletAddress" class="wallet-pill">
          <span class="wallet-dot"></span>{{ shortAddress(walletAddress) }}
        </div>
        <button class="logout-btn" @click="disconnect">
          <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Logout
        </button>
      </div>
    </nav>

    <main class="main">
      <div class="page-hero">
        <h1 class="page-title">Packing House <span class="page-title-highlight">Dashboard</span></h1>
        <p class="page-sub">Receive lots from orchards, manage inventory, and dispatch to transporters</p>
      </div>

      <div class="tab-nav">
        <button class="tab-btn" :class="{ active: activePage === 'pending' }" @click="activePage = 'pending'">
          Pending
          <span v-if="pending.length > 0" class="tab-badge">{{ pending.length }}</span>
        </button>
        <button class="tab-btn" :class="{ active: activePage === 'inventory' }" @click="activePage = 'inventory'">
          Inventory
        </button>
        <button class="tab-btn" :class="{ active: activePage === 'split' }" @click="activePage = 'split'">Split Lot</button>
        <button class="tab-btn" :class="{ active: activePage === 'transfer' }"
          @click="activePage = 'transfer'">Transfer</button>
      </div>

      <!-- ══ PENDING ══ -->
      <div v-if="activePage === 'pending'" class="content">
        <div class="section-label">Lots Awaiting Confirmation</div>
        <transition name="fade">
          <div v-if="confirmSuccess" class="alert-success">✅ LOT #{{ formatLotId(confirmSuccess) }} received — ownership
            transferred on blockchain</div>
        </transition>
        <div v-if="confirmError" class="alert-error">❌ {{ confirmError }}</div>
        <div v-if="isLoading" class="empty-box">Loading from blockchain...</div>
        <div v-else-if="pending.length === 0" class="empty-box">No pending receipts</div>
        <div v-else class="lot-list">
          <div v-for="item in pending" :key="item.lotId" class="lot-card">
            <div class="lot-card-top">
              <span class="lot-id">LOT #{{ formatLotId(item.lotId) }}</span>
              <span class="status-badge" style="background:#fdefd8;color:#7c4a1e;border:1px solid #e8c99a">Awaiting
                Receipt</span>
            </div>
            <div class="lot-variety">{{ item.variety }}</div>
            <div class="lot-info-grid">
              <div class="info-cell">
                <div class="info-label">WEIGHT</div>
                <div class="info-value">{{ item.weightKg.toLocaleString() }} kg</div>
              </div>
              <div class="info-cell">
                <div class="info-label">FROM</div>
                <div class="info-value">{{ displayFrom(item.currentOwner) }}</div>
              </div>
            </div>
            <div class="onchain-preview" style="margin-top:12px">
              <div class="preview-label">
                <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <path d="M8 21h8M12 17v4" />
                </svg>
                Calls receiveLot — will update on-chain
              </div>
              <div class="preview-grid">
                <div class="preview-item"><span class="preview-key">lotId</span><span class="preview-val">{{
                    formatLotId(item.lotId) }}</span></div>
                <div class="preview-item"><span class="preview-key">status</span><span
                    class="preview-val">ReceivedByPackingHouse</span></div>
              </div>
            </div>
            <button class="btn-primary" style="margin-top:14px" @click="confirmReceipt(item.lotId)">Confirm Receipt
              (Sign Transaction)</button>
          </div>
        </div>
      </div>

      <!-- ══ INVENTORY ══ -->
      <div v-else-if="activePage === 'inventory'" class="content">
        <div class="summary-row">
          <div class="summary-card">
            <div class="summary-label">TOTAL LOTS</div>
            <div class="summary-value">{{ inventory.length }}</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">TOTAL WEIGHT</div>
            <div class="summary-value">{{ totalWeight.toLocaleString() }} kg</div>
          </div>
        </div>

        <transition name="fade">
          <div v-if="splitSuccess" class="alert-success">✅ Sub-lot LOT #{{ formatLotId(splitSuccess) }} created on blockchain</div>
        </transition>

        <div class="section-label">Current Inventory</div>
        <div v-if="inventory.length === 0" class="empty-box">Inventory is empty</div>
        <div v-else class="lot-list">
          <div v-for="item in inventory" :key="item.lotId" class="lot-card">
            <div class="lot-card-top">
              <span class="lot-id">LOT #{{ formatLotId(item.lotId) }}</span>
              <span v-if="item.parentLotId > 0" class="status-badge" style="background:#e3f2fd;color:#1565c0;border:1px solid #90caf9">
                Sub-lot of #{{ formatLotId(item.parentLotId) }}
              </span>
              <span v-else class="status-badge" style="background:#e8f5e9;color:#2d6a4f;border:1px solid #a5d6a7">At Packing House</span>
            </div>
            <div class="lot-variety">{{ item.variety }}</div>
            <div class="lot-info-grid">
              <div class="info-cell">
                <div class="info-label">WEIGHT</div>
                <div class="info-value">{{ item.weightKg.toLocaleString() }} kg</div>
              </div>
              <div class="info-cell">
                <div class="info-label">RECEIVED</div>
                <div class="info-value">{{ item.createdAtStr }}</div>
              </div>
            </div>
            <button v-if="item.parentLotId === 0" class="btn-grade" style="margin-top:14px" @click="startSplit(item.lotId)">
              Split Lot 
            </button>
          </div>
        </div>
      </div>

      <!-- ══ SPLIT LOT ══ -->
      <div v-else-if="activePage === 'split'" class="content">
        <div class="section-label">Split Lot → บันทึกบน Smart Contract</div>
        <div class="form-card">
          <transition name="fade">
            <div v-if="splitSuccess" class="alert-success">✅ Sub-lot LOT #{{ formatLotId(splitSuccess) }} created on blockchain</div>
          </transition>
          <div v-if="splitError" class="alert-error">❌ {{ splitError }}</div>

          <!-- Select parent lot -->
          <div class="field">
            <label>SELECT PARENT LOT</label>
            <div v-if="splittableLots.length === 0" class="empty-sm">No original lots in inventory</div>
            <div v-else class="select-list">
              <div v-for="lot in splittableLots" :key="lot.lotId" class="select-item"
                :class="{ selected: splitParentId === lot.lotId }"
                @click="splitParentId = lot.lotId; splitWeight = ''">
                <div>
                  <span class="select-lot-id">LOT #{{ formatLotId(lot.lotId) }}</span>
                  <span class="select-lot-info"> · {{ lot.variety }} · {{ lot.weightKg }}kg</span>
                </div>
                <svg v-if="splitParentId === lot.lotId" width="16" height="16" fill="none" stroke="#7c4a1e"
                  stroke-width="2.5" viewBox="0 0 24 24">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
          </div>

          <template v-if="splitParentId">
            <div class="weight-hint">
              Parent lot weight: <strong>{{ selectedParentWeight }} kg</strong>
            </div>

            <div class="field">
              <label>GRADE</label>
              <select v-model="splitGrade" style="width:100%;padding:13px 16px;border-radius:12px;border:none;background:#fff;font-family:'DM Sans',sans-serif;font-size:14.5px;color:#333;outline:none;">
                <option value="A">Grade A</option>
                <option value="B">Grade B</option>
                <option value="C">Grade C</option>
                <option value="Rejected">Rejected</option>
              </select>
            </div>

            <div class="field">
              <label>WEIGHT (KG)</label>
              <input v-model="splitWeight" type="number" placeholder="0" min="1" :max="selectedParentWeight" />
            </div>

            <div class="onchain-preview">
              <div class="preview-label">
                <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <path d="M8 21h8M12 17v4" />
                </svg>
                Calls splitLot on Smart Contract
              </div>
              <div class="preview-grid">
                <div class="preview-item"><span class="preview-key">_parentLotId</span><span class="preview-val">{{ splitParentId ? formatLotId(splitParentId) : '—' }}</span></div>
                <div class="preview-item"><span class="preview-key">_grade</span><span class="preview-val">{{ splitGrade || '—' }}</span></div>
                <div class="preview-item"><span class="preview-key">_weightKg</span><span class="preview-val">{{ splitWeight || '—' }}</span></div>
              </div>
            </div>

            <button class="btn-primary" :disabled="!canSplit || isSplitting" @click="handleSplitLot">
              <span v-if="isSplitting" class="spinner"></span>
              <span v-else>Split Lot (Sign Transaction)</span>
            </button>
          </template>
        </div>
      </div>

      <!-- ══ TRANSFER ══ -->
      <div v-else-if="activePage === 'transfer'" class="content">
        <div class="chain-flow">
          <div class="chain-step">Orchard</div>
          <svg width="16" height="16" fill="none" stroke="#c4a882" stroke-width="2" viewBox="0 0 24 24">
            <path d="M5 12h14" />
            <path d="M12 5l7 7-7 7" />
          </svg>
          <div class="chain-step active">Packing House</div>
          <svg width="16" height="16" fill="none" stroke="#c4a882" stroke-width="2" viewBox="0 0 24 24">
            <path d="M5 12h14" />
            <path d="M12 5l7 7-7 7" />
          </svg>
          <div class="chain-step">Transporter</div>
          <svg width="16" height="16" fill="none" stroke="#c4a882" stroke-width="2" viewBox="0 0 24 24">
            <path d="M5 12h14" />
            <path d="M12 5l7 7-7 7" />
          </svg>
          <div class="chain-step">Retailer</div>
        </div>

        <div class="section-label">Transfer to Transporter</div>
        <div class="form-card">
          <transition name="fade">
            <div v-if="transferSuccess" class="alert-success">✅ Transfer initiated for LOT #{{
              formatLotId(transferSuccess)
              }}. Waiting for Transporter to confirm.</div>
          </transition>
          <div v-if="transferError" class="alert-error">❌ {{ transferError }}</div>

          <div class="field">
            <label>SELECT LOT</label>
            <div v-if="inventory.length === 0" class="empty-sm">No lots in inventory</div>
            <div v-else class="select-list">
              <div v-for="lot in inventory" :key="lot.lotId" class="select-item"
                :class="{ selected: transferLotId === String(lot.lotId) }" @click="transferLotId = String(lot.lotId)">
                <div>
                  <span class="select-lot-id">LOT #{{ formatLotId(lot.lotId) }}</span>
                  <span class="select-lot-info"> · {{ lot.variety }} · {{ lot.weightKg }}kg</span>
                </div>
                <svg v-if="transferLotId === String(lot.lotId)" width="16" height="16" fill="none" stroke="#7c4a1e"
                  stroke-width="2.5" viewBox="0 0 24 24">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
          </div>

          <div class="field">
            <label>TRANSPORTER</label>
            <RecipientPicker role="Transporter" v-model="transferTo" placeholder="Search company name or 0x..." />
            <span class="field-hint">Search by name or paste wallet address directly</span>
          </div>

          <div class="onchain-preview">
            <div class="preview-label">
              <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
              Calls initiateTransfer on Smart Contract
            </div>
            <div class="preview-grid">
              <div class="preview-item"><span class="preview-key">lotId</span><span class="preview-val">{{ transferLotId
                ?
                  formatLotId(Number(transferLotId)) : '—' }}</span></div>
              <div class="preview-item"><span class="preview-key">_to (Transporter)</span><span
                  class="preview-val mono">{{
                    transferTo ? shortAddress(transferTo) : '—' }}</span></div>
            </div>
          </div>

          <button class="btn-primary" :disabled="!canTransfer || isTransferring" @click="handleTransfer">
            <span v-if="isTransferring" class="spinner"></span>
            <span v-else>Initiate Transfer (Sign Transaction)</span>
          </button>
        </div>
      </div>

    </main>
  </div>
</template>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Sans:wght@400;500;600;700&display=swap');

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

.app {
  min-height: 100vh;
  background: #fffaf4;
  font-family: 'DM Sans', sans-serif;
  position: relative;
  overflow-x: hidden;
}

.blob {
  position: fixed;
  border-radius: 50%;
  filter: blur(90px);
  opacity: 0.28;
  pointer-events: none;
  z-index: 0;
}

.blob-green {
  width: 360px;
  height: 360px;
  background: #a8d5a2;
  bottom: 20px;
  left: -110px;
}

.blob-peach {
  width: 280px;
  height: 280px;
  background: #f5c6a0;
  top: 20px;
  right: -80px;
}

.navbar {
  position: relative;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 22px 40px;
}

.nav-brand {
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.12em;
  color: #2d6a4f;
  text-transform: uppercase;
}

.navbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.wallet-pill {
  display: flex;
  align-items: center;
  gap: 7px;
  background: #fdefd8;
  border: 1px solid #e8c99a;
  border-radius: 20px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 600;
  color: #5c3317;
  user-select: none;
}

.wallet-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #2d6a4f;
  flex-shrink: 0;
}

.logout-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1.5px solid #d9b89a;
  border-radius: 20px;
  padding: 6px 14px;
  font-family: 'DM Sans', sans-serif;
  font-size: 13px;
  font-weight: 600;
  color: #7c4a1e;
  cursor: pointer;
  transition: all 0.2s;
}

.logout-btn:hover {
  background: #fdecea;
  border-color: #c0392b;
  color: #c0392b;
}

.main {
  position: relative;
  z-index: 5;
  max-width: 700px;
  margin: 0 auto;
  padding: 16px 32px 80px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 28px;
}

.page-hero {
  text-align: center;
}

.page-title {
  font-size: 2.2rem;
  font-weight: 700;
  color: #1a1a1a;
  margin-bottom: 8px;
}

.page-title-highlight {
  font-family: 'Playfair Display', serif;
  color: #7c4a1e;
}

.page-sub {
  font-size: 14.5px;
  color: #888;
  line-height: 1.6;
}

.tab-nav {
  display: flex;
  gap: 6px;
  background: #fdefd8;
  border-radius: 14px;
  padding: 6px;
  width: 100%;
}

.tab-btn {
  flex: 1;
  padding: 10px 10px;
  border-radius: 10px;
  border: none;
  background: transparent;
  font-family: 'DM Sans', sans-serif;
  font-size: 13px;
  font-weight: 600;
  color: #9a7a52;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}

.tab-btn.active {
  background: #5c3317;
  color: #fff;
}

.tab-btn:hover:not(.active) {
  background: #f5e6cc;
  color: #5c3317;
}

.tab-badge {
  background: #fff;
  color: #7c4a1e;
  font-size: 0.62rem;
  font-weight: 800;
  border-radius: 10px;
  padding: 1px 6px;
}

.tab-badge.warn {
  background: #fff3e0;
  color: #e65100;
}

.tab-btn.active .tab-badge {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
}

.content {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.summary-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.summary-card {
  background: #fff;
  border-radius: 16px;
  padding: 18px 20px;
  border: 1px solid #f0e6d6;
}

.summary-label {
  font-size: 0.62rem;
  font-weight: 700;
  color: #9a8a72;
  letter-spacing: 0.1em;
  margin-bottom: 6px;
}

.summary-value {
  font-size: 1.5rem;
  font-weight: 800;
  color: #3d2e1e;
}

.section-label {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: #999;
  font-weight: 500;
  white-space: nowrap;
  width: 100%;
}

.section-label::before,
.section-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: #e8dcc8;
}

.lot-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lot-card {
  background: #fff;
  border-radius: 16px;
  padding: 20px 22px;
  border: 1px solid #f0e6d6;
}

.lot-card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.lot-id {
  font-size: 0.72rem;
  font-weight: 700;
  color: #9a8a72;
  letter-spacing: 0.08em;
}

.status-badge {
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 3px 10px;
  border-radius: 20px;
}

.lot-variety {
  font-size: 1.05rem;
  font-weight: 700;
  color: #3d2e1e;
  margin-bottom: 12px;
}

.lot-info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.info-cell {
  background: #faf6f0;
  border-radius: 10px;
  padding: 10px 12px;
  border: 1px solid #f0e6d6;
}

.info-label {
  font-size: 0.6rem;
  font-weight: 700;
  color: #9a8a72;
  letter-spacing: 0.08em;
  margin-bottom: 3px;
}

.info-value {
  font-size: 0.85rem;
  font-weight: 700;
  color: #3d2e1e;
}

/* Grading bars */
.grading-detail {
  margin-top: 12px;
  background: #faf6f0;
  border-radius: 10px;
  padding: 12px 14px;
  border: 1px solid #e8dcc8;
}

.grading-detail-title {
  font-size: 0.62rem;
  font-weight: 700;
  color: #9a7a52;
  letter-spacing: 0.08em;
  margin-bottom: 10px;
  text-transform: uppercase;
}

.grade-bars {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.grade-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.glabel {
  font-size: 0.7rem;
  font-weight: 700;
  width: 52px;
  flex-shrink: 0;
}

.ga {
  color: #2d6a4f;
}

.gb {
  color: #1565c0;
}

.gc {
  color: #e65100;
}

.gr {
  color: #9a8a72;
}

.grade-bar-wrap {
  flex: 1;
  background: #e8dcc8;
  border-radius: 4px;
  height: 8px;
  overflow: hidden;
}

.grade-bar {
  height: 100%;
  border-radius: 4px;
  transition: width 0.6s ease;
}

.ga-bar {
  background: #2d6a4f;
}

.gb-bar {
  background: #1565c0;
}

.gc-bar {
  background: #e65100;
}

.gr-bar {
  background: #baa88a;
}

.gkg {
  font-size: 0.7rem;
  font-weight: 700;
  color: #3d2e1e;
  width: 52px;
  text-align: right;
  flex-shrink: 0;
}

/* Grade form */
.grade-form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.weight-hint {
  font-size: 0.82rem;
  color: #7a6a52;
  background: #faf6f0;
  border-radius: 10px;
  padding: 10px 14px;
  border: 1px solid #e8dcc8;
}

.hint-ok {
  color: #2d6a4f;
  font-weight: 700;
}

.hint-err {
  color: #c0392b;
  font-weight: 700;
}

.error-hint {
  font-size: 0.78rem;
  color: #c0392b;
  font-weight: 600;
  text-align: center;
}

label.ga {
  color: #2d6a4f !important;
}

label.gb {
  color: #1565c0 !important;
}

label.gc {
  color: #e65100 !important;
}

label.gr {
  color: #9a8a72 !important;
}

/* Common */
.empty-box {
  padding: 48px;
  text-align: center;
  color: #baa88a;
  font-size: 0.9rem;
  background: #fff;
  border-radius: 16px;
  border: 1px dashed #e0d5c4;
}

.empty-sm {
  padding: 16px;
  text-align: center;
  color: #baa88a;
  font-size: 0.82rem;
  background: #faf6f0;
  border-radius: 10px;
  border: 1px dashed #e0d5c4;
}

.form-card {
  background: #fdefd8;
  border-radius: 20px;
  padding: 28px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field label {
  font-size: 0.68rem;
  font-weight: 700;
  color: #7c4a1e;
  letter-spacing: 0.1em;
}

.field input {
  padding: 13px 16px;
  border-radius: 12px;
  border: none;
  background: #fff;
  font-family: 'DM Sans', sans-serif;
  font-size: 14.5px;
  color: #333;
  outline: none;
  transition: box-shadow 0.2s;
}

.field input:focus {
  box-shadow: 0 0 0 2px #d4a574;
}

.field-hint {
  font-size: 0.7rem;
  color: #a08060;
}

.mono {
  font-family: monospace !important;
  font-size: 13px !important;
}

.onchain-preview {
  background: #fff;
  border-radius: 12px;
  padding: 14px 16px;
  border: 1px solid #e8c99a;
}

.preview-label {
  font-size: 0.68rem;
  font-weight: 700;
  color: #7c4a1e;
  letter-spacing: 0.06em;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 5px;
}

.preview-grid {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.preview-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.78rem;
}

.preview-key {
  color: #9a7a52;
  font-weight: 600;
}

.preview-val {
  color: #3d2e1e;
  font-weight: 600;
}

.btn-primary {
  width: 100%;
  padding: 15px;
  border-radius: 50px;
  border: none;
  background: #5c3317;
  color: #fff;
  font-family: 'DM Sans', sans-serif;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s, opacity 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 52px;
}

.btn-primary:hover:not(:disabled) {
  background: #7c4a1e;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-grade {
  width: 100%;
  padding: 13px;
  border-radius: 50px;
  border: 1.5px solid #e8c99a;
  background: #fdefd8;
  color: #5c3317;
  font-family: 'DM Sans', sans-serif;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: all 0.2s;
}

.btn-grade:hover {
  background: #f5e0b8;
  border-color: #7c4a1e;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2.5px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.alert-success {
  background: #e8f5e9;
  border: 1px solid #a5d6a7;
  border-radius: 12px;
  padding: 12px 16px;
  font-size: 0.85rem;
  font-weight: 600;
  color: #2d6a4f;
}

.alert-error {
  background: #fdecea;
  border: 1px solid #ef9a9a;
  border-radius: 12px;
  padding: 12px 16px;
  font-size: 0.85rem;
  font-weight: 600;
  color: #b71c1c;
}

.chain-flow {
  background: #fff;
  border-radius: 14px;
  padding: 16px 24px;
  border: 1px solid #f0e6d6;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
  width: 100%;
}

.chain-step {
  padding: 7px 16px;
  border-radius: 8px;
  font-size: 0.78rem;
  font-weight: 600;
  background: #faf6f0;
  color: #9a8a72;
  border: 1px solid #e8dcc8;
}

.chain-step.active {
  background: #5c3317;
  color: #fff;
  border-color: #5c3317;
}

.select-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.select-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-radius: 12px;
  border: 1.5px solid #e8dcc8;
  background: #fff;
  cursor: pointer;
  transition: all 0.15s;
}

.select-item:hover {
  border-color: #c4a882;
}

.select-item.selected {
  border-color: #7c4a1e;
  background: #faf6f0;
}

.select-lot-id {
  font-size: 0.88rem;
  font-weight: 700;
  color: #3d2e1e;
}

.select-lot-info {
  font-size: 0.82rem;
  color: #9a8a72;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s, transform 0.3s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>