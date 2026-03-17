/**
 * Room Availability Controller
 * Slot-system-aware room availability queries
 * GET /rooms/availability?date=&slot=&slotSystemId=
 */
const { query } = require('express-validator');
const db = require('../config/database');
const slotResolutionService = require('../services/slotResolutionService');
const { asyncHandler } = require('../utils/errorHandler');

/**
 * Validation for availability query
 */
const availabilityValidation = [
    query('date')
        .matches(/^\d{4}-\d{2}-\d{2}$/)
        .withMessage('Date must be in YYYY-MM-DD format'),
    query('slotSystemId')
        .isUUID()
        .withMessage('Valid slot system ID is required'),
    query('slot')
        .optional()
        .trim()
        .isLength({ min: 1, max: 20 })
        .withMessage('Slot code is required'),
];

/**
 * Get room availability for a date/slot/slotSystem
 * GET /api/rooms/availability?date=2025-01-15&slot=A&slotSystemId=...
 * 
 * Returns available and occupied rooms with capacity info
 */
const getAvailability = asyncHandler(async (req, res) => {
    const { date, slot, slotSystemId } = req.query;

    // Determine time blocks to check
    let timeBlocks = [];

    if (slot) {
        // Resolve slot to time blocks
        timeBlocks = await slotResolutionService.resolve(slot, slotSystemId, {});

        // Filter to the day of the requested date
        const dayOfWeek = new Date(date).getDay();
        const dayMap = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };
        const targetDay = dayMap[dayOfWeek];

        timeBlocks = timeBlocks.filter(b => b.day === targetDay);
    }

    // Get all active rooms
    const roomsResult = await db.query(
        `SELECT r.id, r.room_number, r.name, r.capacity, r.room_type,
            b_name.name as building_name
     FROM rooms r
     JOIN buildings b_name ON r.building_id = b_name.id
     WHERE r.is_active = true
     ORDER BY r.capacity, r.room_number`
    );

    const allRooms = roomsResult.rows;
    const available = [];
    const occupied = [];

    if (timeBlocks.length === 0 && slot) {
        // Slot doesn't map to any time on this day — all rooms are available
        return res.json({
            success: true,
            data: {
                date,
                slot,
                slotSystemId,
                available: allRooms,
                occupied: [],
                message: 'Slot has no time blocks on this day',
            },
        });
    }

    if (timeBlocks.length === 0 && !slot) {
        // No slot specified — return all rooms (no filtering)
        return res.json({
            success: true,
            data: {
                date,
                slotSystemId,
                available: allRooms,
                occupied: [],
                message: 'No slot specified — showing all rooms',
            },
        });
    }

    // For each room, check if it conflicts with any of the time blocks
    for (const room of allRooms) {
        let isOccupied = false;
        const roomConflicts = [];

        for (const block of timeBlocks) {
            // Check bookings table
            const bookingConflict = await db.query(
                `SELECT b.id, b.start_time, b.end_time, c.course_code
         FROM bookings b
         LEFT JOIN courses c ON b.course_id = c.id
         WHERE b.room_id = $1
           AND b.date = $2
           AND b.is_active = true
           AND b.start_time < $4
           AND b.end_time > $3`,
                [room.id, date, block.startTime, block.endTime]
            );

            // Check booking_requests table
            const requestConflict = await db.query(
                `SELECT id, start_time, end_time, event_title
         FROM booking_requests
         WHERE room_id = $1
           AND booking_date = $2
           AND status IN ('approved', 'pending_staff')
           AND start_time < $4
           AND end_time > $3`,
                [room.id, date, block.startTime, block.endTime]
            );

            if (bookingConflict.rows.length > 0 || requestConflict.rows.length > 0) {
                isOccupied = true;
                roomConflicts.push({
                    timeBlock: block,
                    bookings: bookingConflict.rows,
                    requests: requestConflict.rows,
                });
            }
        }

        if (isOccupied) {
            occupied.push({ ...room, conflicts: roomConflicts });
        } else {
            available.push(room);
        }
    }

    res.json({
        success: true,
        data: {
            date,
            slot,
            slotSystemId,
            timeBlocks,
            available,
            occupied,
            summary: {
                totalRooms: allRooms.length,
                availableCount: available.length,
                occupiedCount: occupied.length,
            },
        },
    });
});

module.exports = {
    availabilityValidation,
    getAvailability,
};
