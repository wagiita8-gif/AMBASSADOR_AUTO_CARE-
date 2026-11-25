
'use strict';

const express = require('express');
const router = express.Router();

// --------------------------------------------------
// AUTHENTICATION
// --------------------------------------------------

// These are supplied by server.js when the router
// is mounted. The router expects:
// req.user = { id: userId }
// req.shopId = authenticated shop ID
// req.userRole = owner / manager / staff

function requireShop(req, res, next) {
    if (!req.user || !req.user.id) {
        return res.status(401).json({
            error: 'Authentication required'
        });
    }

    if (!req.shopId) {
        return res.status(400).json({
            error: 'Shop context missing'
        });
    }

    next();
}

function requireManager(req, res, next) {
    if (!['owner', 'manager'].includes(req.userRole)) {
        return res.status(403).json({
            error: 'Insufficient permissions'
        });
    }

    next();
}

function getPool(req) {
    return req.app.locals.pool;
}

// --------------------------------------------------
// VALIDATION
// --------------------------------------------------

function validateParty(body) {
    const name = String(body.name || '').trim();

    if (!name) {
        return 'Name is required';
    }

    if (name.length > 150) {
        return 'Name must not exceed 150 characters';
    }

    const phone = body.phone
        ? String(body.phone).trim()
        : null;

    const email = body.email
        ? String(body.email).trim()
        : null;

    if (phone && phone.length > 30) {
        return 'Phone number is too long';
    }

    if (email && email.length > 150) {
        return 'Email is too long';
    }

    if (
        email &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
        return 'Invalid email address';
    }

    return null;
}

function partyData(body) {
    return {
        name: String(body.name).trim(),
        phone: body.phone
            ? String(body.phone).trim()
            : null,
        email: body.email
            ? String(body.email).trim()
            : null,
        address: body.address
            ? String(body.address).trim()
            : null,
        notes: body.notes
            ? String(body.notes).trim()
            : null
    };
}

// --------------------------------------------------
// CUSTOMER ROUTES
// --------------------------------------------------

// GET all customers
router.get(
    '/customers',
    requireShop,
    async (req, res) => {
        try {
            const pool = getPool(req);

            const result = await pool.query(
                `SELECT *
                 FROM customers
                 WHERE shop_id = $1
                 ORDER BY created_at DESC`,
                [req.shopId]
            );

            res.json({
                customers: result.rows
            });

        } catch (error) {
            console.error('Get customers:', error);

            res.status(500).json({
                error: 'Could not retrieve customers'
            });
        }
    }
);

// CREATE customer
router.post(
    '/customers',
    requireShop,
    requireManager,
    async (req, res) => {
        try {
            const validation = validateParty(req.body);

            if (validation) {
                return res.status(400).json({
                    error: validation
                });
            }

            const data = partyData(req.body);
            const pool = getPool(req);

            const result = await pool.query(
                `INSERT INTO customers
                 (shop_id, name, phone, email, address, notes)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
                [
                    req.shopId,
                    data.name,
                    data.phone,
                    data.email,
                    data.address,
                    data.notes
                ]
            );

            res.status(201).json({
                message: 'Customer created successfully',
                customer: result.rows[0]
            });

        } catch (error) {
            console.error('Create customer:', error);

            res.status(500).json({
                error: 'Could not create customer'
            });
        }
    }
);

// UPDATE customer
router.patch(
    '/customers/:customerId',
    requireShop,
    requireManager,
    async (req, res) => {
        try {
            const validation = validateParty(req.body);

            if (validation) {
                return res.status(400).json({
                    error: validation
                });
            }

            const data = partyData(req.body);
            const pool = getPool(req);

            const result = await pool.query(
                `UPDATE customers
                 SET name = $1,
                     phone = $2,
                     email = $3,
                     address = $4,
                     notes = $5,
                     updated_at = NOW()
                 WHERE id = $6
                   AND shop_id = $7
                 RETURNING *`,
                [
                    data.name,
                    data.phone,
                    data.email,
                    data.address,
                    data.notes,
                    req.params.customerId,
                    req.shopId
                ]
            );

            if (!result.rowCount) {
                return res.status(404).json({
                    error: 'Customer not found'
                });
            }

            res.json({
                message: 'Customer updated successfully',
                customer: result.rows[0]
            });

        } catch (error) {
            console.error('Update customer:', error);

            res.status(500).json({
                error: 'Could not update customer'
            });
        }
    }
);

// DELETE customer
router.delete(
    '/customers/:customerId',
    requireShop,
    requireManager,
    async (req, res) => {
        try {
            const pool = getPool(req);

            const result = await pool.query(
                `DELETE FROM customers
                 WHERE id = $1
                   AND shop_id = $2
                 RETURNING id`,
                [
                    req.params.customerId,
                    req.shopId
                ]
            );

            if (!result.rowCount) {
                return res.status(404).json({
                    error: 'Customer not found'
                });
            }

            res.json({
                message: 'Customer deleted successfully'
            });

        } catch (error) {
            console.error('Delete customer:', error);

            res.status(500).json({
                error: 'Could not delete customer'
            });
        }
    }
);

// --------------------------------------------------
// SUPPLIER ROUTES
// --------------------------------------------------

// GET all suppliers
router.get(
    '/suppliers',
    requireShop,
    async (req, res) => {
        try {
            const pool = getPool(req);

            const result = await pool.query(
                `SELECT *
                 FROM suppliers
                 WHERE shop_id = $1
                 ORDER BY created_at DESC`,
                [req.shopId]
            );

            res.json({
                suppliers: result.rows
            });

        } catch (error) {
            console.error('Get suppliers:', error);

            res.status(500).json({
                error: 'Could not retrieve suppliers'
            });
        }
    }
);

// CREATE supplier
router.post(
    '/suppliers',
    requireShop,
    requireManager,
    async (req, res) => {
        try {
            const validation = validateParty(req.body);

            if (validation) {
                return res.status(400).json({
                    error: validation
                });
            }

            const data = partyData(req.body);
            const pool = getPool(req);

            const result = await pool.query(
                `INSERT INTO suppliers
                 (shop_id, name, phone, email, address, notes)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
                [
                    req.shopId,
                    data.name,
                    data.phone,
                    data.email,
                    data.address,
                    data.notes
                ]
            );

            res.status(201).json({
                message: 'Supplier created successfully',
                supplier: result.rows[0]
            });

        } catch (error) {
            console.error('Create supplier:', error);

            res.status(500).json({
                error: 'Could not create supplier'
            });
        }
    }
);

// UPDATE supplier
router.patch(
    '/suppliers/:supplierId',
    requireShop,
    requireManager,
    async (req, res) => {
        try {
            const validation = validateParty(req.body);

            if (validation) {
                return res.status(400).json({
                    error: validation
                });
            }

            const data = partyData(req.body);
            const pool = getPool(req);

            const result = await pool.query(
                `UPDATE suppliers
                 SET name = $1,
                     phone = $2,
                     email = $3,
                     address = $4,
                     notes = $5,
                     updated_at = NOW()
                 WHERE id = $6
                   AND shop_id = $7
                 RETURNING *`,
                [
                    data.name,
                    data.phone,
                    data.email,
                    data.address,
                    data.notes,
                    req.params.supplierId,
                    req.shopId
                ]
            );

            if (!result.rowCount) {
                return res.status(404).json({
                    error: 'Supplier not found'
                });
            }

            res.json({
                message: 'Supplier updated successfully',
                supplier: result.rows[0]
            });

        } catch (error) {
            console.error('Update supplier:', error);

            res.status(500).json({
                error: 'Could not update supplier'
            });
        }
    }
);

// DELETE supplier
router.delete(
    '/suppliers/:supplierId',
    requireShop,
    requireManager,
    async (req, res) => {
        try {
            const pool = getPool(req);

            const result = await pool.query(
                `DELETE FROM suppliers
                 WHERE id = $1
                   AND shop_id = $2
                 RETURNING id`,
                [
                    req.params.supplierId,
                    req.shopId
                ]
            );

            if (!result.rowCount) {
                return res.status(404).json({
                    error: 'Supplier not found'
                });
            }

            res.json({
                message: 'Supplier deleted successfully'
            });

        } catch (error) {
            console.error('Delete supplier:', error);

            res.status(500).json({
                error: 'Could not delete supplier'
            });
        }
    }
);

module.exports = router;
