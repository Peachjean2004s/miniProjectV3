import { getContract } from './contract'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export const Status = {
  Harvested: 0,
  ReceivedByPackingHouse: 1,
  InTransit: 2,
  ReceivedByRetailer: 3,
  Sold: 4,
} as const

export const STATUS_LABEL: Record<number, string> = {
  0: 'Harvested',
  1: 'At Packing House',
  2: 'In Transit',
  3: 'At Retailer',
  4: 'Sold',
}

export const STATUS_STYLE: Record<number, { bg: string; text: string; border: string }> = {
  0: { bg: '#e8f5e9', text: '#2d6a4f', border: '#a5d6a7' },
  1: { bg: '#fdefd8', text: '#7c4a1e', border: '#e8c99a' },
  2: { bg: '#fff3e0', text: '#e65100', border: '#ffcc80' },
  3: { bg: '#e3f2fd', text: '#1565c0', border: '#90caf9' },
  4: { bg: '#f3e5f5', text: '#6a1b9a', border: '#ce93d8' },
}

export interface LotInfo {
  lotId: number
  variety: string
  weightKg: number
  orchard: string
  currentOwner: string
  nextOwner: string   // ZERO_ADDRESS if none
  status: number
  createdAt: number   // unix seconds
  createdAtStr: string
  parentLotId: number // 0 = original lot, >0 = sub-lot
}

export interface TrackStep {
  name: string
  actor: string
  displayName: string
  action: string
  time: string
  done: boolean
}

export function formatTs(unix: number): string {
  if (!unix) return '—'
  return new Date(unix * 1000).toLocaleString('th-TH', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

export function formatLotId(id: number): string {
  return String(id).padStart(4, '0')
}

export function hasPendingTransfer(lot: LotInfo): boolean {
  return lot.nextOwner !== ZERO_ADDRESS
}

function parseEvent(receipt: any, contract: any, name: string) {
  return receipt.logs
    ?.map((log: any) => { try { return contract.interface.parseLog(log) } catch { return null } })
    .find((e: any) => e?.name === name) ?? null
}

// ── สร้าง lot ใหม่ (Orchard only) ────────────────────────────────────────────
export async function txRegisterLot(variety: string, weightKg: number) {
  const contract = await getContract()
  const tx = await contract.registerLot(variety, weightKg)
  const receipt = await tx.wait()
  const event = parseEvent(receipt, contract, 'LotRegistered')
  return {
    txHash: tx.hash as string,
    blockNumber: receipt.blockNumber as number,
    lotId: event ? Number(event.args.lotId) : null,
    timestamp: event ? Number(event.args.timestamp) : null,
  }
}

// ── Initiate transfer ──────────────────────────────────────────────────────────
export async function txInitiateTransfer(lotId: number, toAddress: string) {
  const contract = await getContract()
  const tx = await contract.initiateTransfer(lotId, toAddress)
  const receipt = await tx.wait()
  const event = parseEvent(receipt, contract, 'HandshakeInitiated')
  return {
    txHash: tx.hash as string,
    blockNumber: receipt.blockNumber as number,
    timestamp: event ? Number(event.args.timestamp) : null,
  }
}

// ── Receive lot ───────────────────────────────────────────────────────────────
export async function txReceiveLot(lotId: number) {
  const contract = await getContract()
  const tx = await contract.receiveLot(lotId)
  const receipt = await tx.wait()
  const event = parseEvent(receipt, contract, 'HandshakeCompleted')
  return {
    txHash: tx.hash as string,
    blockNumber: receipt.blockNumber as number,
    newStatus: event ? Number(event.args.newStatus) : null,
    timestamp: event ? Number(event.args.timestamp) : null,
  }
}

// ── Split lot (PackingHouse only) ─────────────────────────────────────────────
export async function txSplitLot(parentLotId: number, grade: string, weightKg: number) {
  const contract = await getContract()
  const tx = await contract.splitLot(parentLotId, grade, weightKg)
  const receipt = await tx.wait()
  const event = parseEvent(receipt, contract, 'LotSplit')
  return {
    txHash: tx.hash as string,
    blockNumber: receipt.blockNumber as number,
    subLotId: event ? Number(event.args.subLotId) : null,
    timestamp: event ? Number(event.args.timestamp) : null,
  }
}

// ── Sell lot ──────────────────────────────────────────────────────────────────
export async function txSellLot(lotId: number) {
  const contract = await getContract()
  const tx = await contract.sellLot(lotId)
  const receipt = await tx.wait()
  const event = parseEvent(receipt, contract, 'LotSold')
  return {
    txHash: tx.hash as string,
    blockNumber: receipt.blockNumber as number,
    timestamp: event ? Number(event.args.timestamp) : null,
  }
}

// ── Error message helper ───────────────────────────────────────────────────────
export function parseContractError(e: any): string {
  if (e?.code === 4001 || e?.code === 'ACTION_REJECTED') return 'Transaction rejected by user.'
  const reason = (e?.reason || e?.data?.message || e?.message || '').toLowerCase()
  if (reason.includes('already registered')) return 'Already registered.'
  if (reason.includes('receiver not registered')) return 'Recipient is not registered on this contract.'
  if (reason.includes('not registered')) return 'Wallet not registered in this role.'
  if (reason.includes('not the current owner')) return 'You are not the current owner of this lot.'
  if (reason.includes('orchard must send to packinghouse')) return 'Orchard can only transfer to Packing House.'
  if (reason.includes('packinghouse must send to transporter')) return 'Packing House can only transfer to Transporter.'
  if (reason.includes('transporter must send to retailer')) return 'Transporter can only transfer to Retailer.'
  if (reason.includes('cannot split a sub-lot')) return 'Cannot split a sub-lot, only original lots can be split.'
  if (reason.includes('exceeds parent weight')) return 'Sub-lot weight exceeds remaining parent lot weight.'
  if (reason.includes('parent lot must be receivedbypackinghouse')) return 'Parent lot must be at Packing House status to split.'
  if (reason.includes('unauthorized')) return 'Unauthorized: you do not have permission for this action.'
  return (e?.reason || e?.data?.message || e?.message || '') || 'Transaction failed.'
}

// ตรวจสอบว่า MetaMask account ตรงกับ wallet ที่ login ไว้
export async function assertWalletMatch(storedAddress: string): Promise<void> {
  if (!window.ethereum) throw new Error('MetaMask not installed')
  const accounts = await window.ethereum.request({ method: 'eth_accounts' }) as string[]
  if (!accounts.length) throw new Error('No MetaMask account connected. Please connect MetaMask.')
  if (accounts[0].toLowerCase() !== storedAddress.toLowerCase()) {
    throw new Error(
      `MetaMask account (${accounts[0].slice(0, 6)}...${accounts[0].slice(-4)}) ` +
      `does not match your logged-in wallet. Please switch MetaMask account.`
    )
  }
}
