const STATUS_NAME = {
  0: 'Harvested',
  1: 'ReceivedByPackingHouse',
  2: 'InTransit',
  3: 'ReceivedByRetailer',
  4: 'Sold',
}

// INSERT lot ใหม่ (ตอน LotRegistered) — lot table เก็บแค่ ownership/status
export async function insertLot(client, { lotId, orchardAddress }) {
  await client.query(
    `INSERT INTO lot (lot_id, parent_lot_id, current_owner, next_owner, status)
     VALUES ($1, NULL, $2, NULL, 'Harvested')
     ON CONFLICT (lot_id) DO NOTHING`,
    [lotId, orchardAddress]
  )
}

// INSERT sub-lot (ตอน LotSplit) — parent_lot_id ชี้ไปหา original lot
export async function insertSubLot(client, { lotId, parentLotId, packingHouseAddress }) {
  await client.query(
    `INSERT INTO lot (lot_id, parent_lot_id, current_owner, next_owner, status)
     VALUES ($1, $2, $3, NULL, 'ReceivedByPackingHouse')
     ON CONFLICT (lot_id) DO NOTHING`,
    [lotId, parentLotId, packingHouseAddress]
  )
}

// INSERT lot_grading — บันทึก grading session ของ parent lot (UNIQUE per lot_id)
export async function insertLotGrading(client, { parentLotId, gradedBy, txHash }) {
  await client.query(
    `INSERT INTO lot_grading (lot_id, graded_by, tx_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT ON CONSTRAINT unique_lot_grading DO NOTHING`,
    [parentLotId, gradedBy, txHash]
  )
}

// UPDATE lot เมื่อ HandshakeInitiated (set next_owner)
export async function updateLotNextOwner(client, { lotId, nextOwner }) {
  await client.query(
    `UPDATE lot SET next_owner = $2 WHERE lot_id = $1`,
    [lotId, nextOwner]
  )
}

// UPDATE lot เมื่อ HandshakeCompleted (เปลี่ยน owner + status + clear next_owner)
export async function updateLotOwner(client, { lotId, newOwner, newStatus }) {
  const statusName = STATUS_NAME[newStatus] || 'Harvested'
  await client.query(
    `UPDATE lot SET current_owner = $2, status = $3, next_owner = NULL WHERE lot_id = $1`,
    [lotId, newOwner, statusName]
  )
}

// UPDATE lot เมื่อ LotSold
export async function updateLotSold(client, { lotId }) {
  await client.query(
    `UPDATE lot SET status = 'Sold' WHERE lot_id = $1`,
    [lotId]
  )
}

// GET lot จาก DB
export async function getLotById(lotId) {
  const { default: pool } = await import('../config/db.js')
  const result = await pool.query(
    `SELECT lot_id, parent_lot_id, current_owner, next_owner, status
     FROM lot WHERE lot_id = $1`,
    [lotId]
  )
  return result.rows[0] || null
}
