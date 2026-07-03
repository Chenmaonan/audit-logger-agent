// src/auditReview/lockStore.js
import crypto from 'crypto';

function nowIso() {
  return new Date().toISOString();
}

function leaseExpiresAt(leaseMinutes) {
  return new Date(Date.now() + leaseMinutes * 60 * 1000).toISOString();
}

export function createLockStore(db) {
  const getLockStmt = db.prepare(`SELECT * FROM audit_review_locks WHERE lock_name = ?`);

  const insertStmt = db.prepare(`
    INSERT INTO audit_review_locks (lock_name, owner_id, lease_expires_at, updated_at)
    VALUES (@lock_name, @owner_id, @lease_expires_at, @updated_at)
  `);

  const updateStmt = db.prepare(`
    UPDATE audit_review_locks
    SET owner_id = @owner_id,
        lease_expires_at = @lease_expires_at,
        updated_at = @updated_at
    WHERE lock_name = @lock_name
  `);

  const refreshStmt = db.prepare(`
    UPDATE audit_review_locks
    SET lease_expires_at = @lease_expires_at,
        updated_at = @updated_at
    WHERE lock_name = @lock_name AND owner_id = @owner_id
  `);

  const releaseStmt = db.prepare(`
    DELETE FROM audit_review_locks WHERE lock_name = @lock_name AND owner_id = @owner_id
  `);

  const forceReleaseStmt = db.prepare(`DELETE FROM audit_review_locks WHERE lock_name = ?`);

  const listExpiredStmt = db.prepare(`
    SELECT * FROM audit_review_locks WHERE lease_expires_at <= @before_iso
  `);

  return {
    acquire({ lockName = 'audit_review_scheduler', ownerId, leaseMinutes = 10 } = {}) {
      const owner = ownerId ?? crypto.randomUUID();
      const now = nowIso();
      const expiresAt = leaseExpiresAt(leaseMinutes);
      const existing = getLockStmt.get(lockName);
      if (!existing) {
        insertStmt.run({
          lock_name: lockName,
          owner_id: owner,
          lease_expires_at: expiresAt,
          updated_at: now,
        });
        return { acquired: true, ownerId: owner, leaseExpiresAt: expiresAt };
      }
      const leaseExpired = existing.lease_expires_at <= now;
      const sameOwner = existing.owner_id === owner;
      if (leaseExpired || sameOwner) {
        updateStmt.run({
          lock_name: lockName,
          owner_id: owner,
          lease_expires_at: expiresAt,
          updated_at: now,
        });
        return { acquired: true, ownerId: owner, leaseExpiresAt: expiresAt };
      }
      return {
        acquired: false,
        currentOwner: existing.owner_id,
        leaseExpiresAt: existing.lease_expires_at,
      };
    },

    refresh({ lockName, ownerId, leaseMinutes = 10 }) {
      const expiresAt = leaseExpiresAt(leaseMinutes);
      const info = refreshStmt.run({
        lock_name: lockName,
        owner_id: ownerId,
        lease_expires_at: expiresAt,
        updated_at: nowIso(),
      });
      return { refreshed: info.changes };
    },

    release({ lockName, ownerId }) {
      const info = releaseStmt.run({ lock_name: lockName, owner_id: ownerId });
      return { released: info.changes };
    },

    getLock(lockName) {
      return getLockStmt.get(lockName) ?? null;
    },

    listExpired({ beforeIso }) {
      return listExpiredStmt.all({ before_iso: beforeIso });
    },

    forceRelease(lockName) {
      const info = forceReleaseStmt.run(lockName);
      return { released: info.changes };
    },
  };
}