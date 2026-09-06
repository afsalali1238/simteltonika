// ─────────────────────────────────────────────────────────────────────────────
// buffered-device.js — SimDevice plus the one behaviour that makes a tracker a
// tracker rather than a UDP firehose: it does not forget.
//
// A real FMC-series unit stores records in flash. It sends a batch, and it only
// erases those records once the server has ACKed the count. Lose the link
// mid-drive and the records pile up; get the link back and they all arrive, in
// order, with their ORIGINAL timestamps — not the time they were finally
// delivered. That is why a tracker can be offline for a day and still produce a
// correct utilisation figure afterwards.
//
// This wrapper models exactly that and nothing more:
//   • records queue while disconnected
//   • on reconnect it re-handshakes, then drains oldest-first
//   • a record leaves the buffer only after the ACK covers it
//   • the queue is capped; the OLDEST records are dropped when it overflows,
//     which is what the hardware does (newest data is the most useful)
//
// It is the device side of invariant 1 ("ACK only after a durable write"): the
// server must not ACK until the data is safe, because this buffer trusts the ACK
// completely and erases on the strength of it. A server that ACKs early causes
// permanent, silent data loss right here.
// ─────────────────────────────────────────────────────────────────────────────

import { SimDevice } from './device.js';

export class BufferedDevice {
  /**
   * @param {object} o
   * @param {string} o.host  server address (Configurator param 2004)
   * @param {number} o.port  server port    (param 2005)
   * @param {string} o.imei  the burned-in IMEI
   * @param {'8'|'8E'} [o.codec]
   * @param {boolean} [o.bufferEnabled] false = a record sent while offline is lost
   * @param {number} [o.maxRecords] backlog cap before the oldest are dropped
   * @param {number} [o.perPacket] records per AVL packet
   * @param {(e:object)=>void} [o.onEvent] observability hook; see EVENTS below
   */
  constructor({
    host,
    port,
    imei,
    codec = '8E',
    bufferEnabled = true,
    maxRecords = 1000,
    perPacket = 1,
    onEvent,
  }) {
    Object.assign(this, { host, port, imei, codec, bufferEnabled, maxRecords, perPacket });
    this.onEvent = onEvent ?? (() => {});
    this.buffer = [];
    this.dev = null;
    this.connected = false;
    this.stats = {
      queued: 0,
      sent: 0,
      acked: 0,
      droppedOverflow: 0,
      droppedNoBuffer: 0,
      connects: 0,
      handshakeRejects: 0,
      linkDrops: 0,
      ackMismatches: 0,
    };
  }

  /**
   * Connect + IMEI handshake. Resolves true on 0x01, false on 0x00 or any
   * transport failure — the caller decides whether that is fatal, because for a
   * real unit it is not: it retries.
   */
  async connect() {
    try {
      this.dev = new SimDevice({
        host: this.host,
        port: this.port,
        imei: this.imei,
        codec: this.codec,
      });
      await this.dev.connect();
      this.connected = true;
      this.stats.connects++;
      // A dropped link must not throw out of a timer callback.
      this.dev.socket.on('close', () => {
        if (this.connected) {
          this.connected = false;
          this.stats.linkDrops++;
          this.onEvent({ type: 'link-down', buffered: this.buffer.length });
        }
      });
      this.onEvent({ type: 'handshake-accepted', imei: this.imei, buffered: this.buffer.length });
      return true;
    } catch (err) {
      this.connected = false;
      const rejected = /rejected IMEI/.test(err.message);
      if (rejected) this.stats.handshakeRejects++;
      this.onEvent({
        type: rejected ? 'handshake-rejected' : 'connect-failed',
        imei: this.imei,
        reason: err.message,
        code: err.code,
      });
      return false;
    }
  }

  /** Queue records the way flash does. Honours the cap and the enabled flag. */
  enqueue(records) {
    const recs = Array.isArray(records) ? records : [records];
    if (!this.bufferEnabled && !this.connected) {
      this.stats.droppedNoBuffer += recs.length;
      this.onEvent({ type: 'dropped-no-buffer', count: recs.length });
      return;
    }
    this.buffer.push(...recs);
    this.stats.queued += recs.length;
    if (this.buffer.length > this.maxRecords) {
      const over = this.buffer.length - this.maxRecords;
      this.buffer.splice(0, over); // oldest go first, as on real hardware
      this.stats.droppedOverflow += over;
      this.onEvent({ type: 'dropped-overflow', count: over, cap: this.maxRecords });
    }
  }

  /**
   * Drain the backlog oldest-first. A record is removed ONLY after the ACK
   * covers it. Returns the number of records the server acknowledged.
   *
   * An ACK that is short of what we sent is treated the way a real unit treats
   * it: the uncovered records stay queued and go again. That is the mechanism
   * that makes duplicate delivery normal — and therefore why the server's
   * ingest must be idempotent (invariant 2).
   */
  async flush() {
    if (!this.connected || this.buffer.length === 0) return 0;
    let ackedTotal = 0;
    while (this.buffer.length > 0 && this.connected) {
      const batch = this.buffer.slice(0, this.perPacket);
      let ack;
      try {
        ack = await this.dev.send(batch);
      } catch (err) {
        this.connected = false;
        this.onEvent({ type: 'send-failed', reason: err.message, buffered: this.buffer.length });
        break;
      }
      this.stats.sent += batch.length;
      if (ack === batch.length) {
        this.buffer.splice(0, batch.length);
        this.stats.acked += ack;
        ackedTotal += ack;
        this.onEvent({ type: 'acked', count: ack, buffered: this.buffer.length });
      } else {
        // Partial/mismatched ACK: keep the uncovered tail. Never assume.
        const covered = Math.max(0, Math.min(ack, batch.length));
        this.buffer.splice(0, covered);
        this.stats.acked += covered;
        this.stats.ackMismatches++;
        ackedTotal += covered;
        this.onEvent({
          type: 'ack-mismatch',
          sent: batch.length,
          ack,
          kept: this.buffer.length,
        });
        break;
      }
    }
    return ackedTotal;
  }

  /** Queue then immediately try to send. The normal steady-state path. */
  async send(records) {
    this.enqueue(records);
    return this.flush();
  }

  get pending() {
    return this.buffer.length;
  }

  close() {
    this.connected = false;
    this.dev?.close();
  }
}

/**
 * Event types emitted through `onEvent`, for anyone writing a UI or a test:
 *
 *   handshake-accepted   server returned 0x01
 *   handshake-rejected   server returned 0x00 — IMEI not in its device registry
 *   connect-failed       never got a TCP connection (wrong port, host down)
 *   acked                a batch was acknowledged and erased from the buffer
 *   ack-mismatch         ACK count != records sent; the tail was kept
 *   link-down            the socket closed while we thought we were connected
 *   send-failed          write/ACK-read failed mid-flush; records kept
 *   dropped-overflow     backlog exceeded the cap; OLDEST records discarded
 *   dropped-no-buffer    buffering off and offline, so the record is gone
 */
export const EVENTS = [
  'handshake-accepted',
  'handshake-rejected',
  'connect-failed',
  'acked',
  'ack-mismatch',
  'link-down',
  'send-failed',
  'dropped-overflow',
  'dropped-no-buffer',
];
