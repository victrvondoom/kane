/* Chess rules with a8 at index 0 and h1 at index 63. No external dependencies. */
(function (root) {
  'use strict';
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
  const color = p => p ? (p === p.toUpperCase() ? 'w' : 'b') : null;
  const other = c => c === 'w' ? 'b' : 'w';
  const index = s => (8 - Number(s[1])) * 8 + s.charCodeAt(0) - 97;
  const inside = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const rays = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
  const knights = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];

  class Chess {
    constructor(fen = START) {
      const [layout, turn, castling, ep] = fen.split(/\s+/);
      this.board = [];
      for (const ch of layout.replaceAll('/', '')) {
        if (/[1-8]/.test(ch)) this.board.push(...Array(Number(ch)).fill(null));
        else if (/[prnbqkPRNBQK]/.test(ch)) this.board.push(ch);
        else throw new Error('Invalid FEN piece');
      }
      if (this.board.length !== 64 || !['w', 'b'].includes(turn)) throw new Error('Invalid FEN');
      this.turn = turn;
      this.castling = castling === '-' ? '' : castling;
      this.ep = ep === '-' ? null : index(ep);
    }

    clone() {
      const copy = Object.create(Chess.prototype);
      copy.board = this.board.slice();
      copy.turn = this.turn;
      copy.castling = this.castling;
      copy.ep = this.ep;
      return copy;
    }

    attacked(square, by) {
      const r = Math.floor(square / 8), c = square % 8;
      const pawnRow = r + (by === 'w' ? 1 : -1);
      for (const dc of [-1, 1]) {
        if (inside(pawnRow, c + dc)) {
          const p = this.board[pawnRow * 8 + c + dc];
          if (color(p) === by && p.toLowerCase() === 'p') return true;
        }
      }
      for (const [dr, dc] of knights) {
        if (!inside(r + dr, c + dc)) continue;
        const p = this.board[(r + dr) * 8 + c + dc];
        if (color(p) === by && p.toLowerCase() === 'n') return true;
      }
      for (let d = 0; d < rays.length; d++) {
        const [dr, dc] = rays[d];
        for (let n = 1; inside(r + dr * n, c + dc * n); n++) {
          const p = this.board[(r + dr * n) * 8 + c + dc * n];
          if (!p) continue;
          if (color(p) === by) {
            const type = p.toLowerCase();
            if (type === 'q' || type === (d < 4 ? 'r' : 'b') || (n === 1 && type === 'k')) return true;
          }
          break;
        }
      }
      return false;
    }

    inCheck(side = this.turn) {
      const king = this.board.indexOf(side === 'w' ? 'K' : 'k');
      return king < 0 || this.attacked(king, other(side));
    }

    pseudoMoves() {
      const moves = [], side = this.turn;
      const add = (from, to, extra = {}) => {
        if (this.board[from].toLowerCase() === 'p' && (to < 8 || to >= 56)) {
          for (const promotion of ['q', 'r', 'b', 'n']) moves.push({from, to, promotion, ...extra});
        } else moves.push({from, to, ...extra});
      };
      for (let from = 0; from < 64; from++) {
        const p = this.board[from];
        if (color(p) !== side) continue;
        const type = p.toLowerCase(), r = Math.floor(from / 8), c = from % 8;
        if (type === 'p') {
          const dr = side === 'w' ? -1 : 1, next = from + dr * 8;
          if (inside(r + dr, c) && !this.board[next]) {
            add(from, next);
            if (r === (side === 'w' ? 6 : 1) && !this.board[from + dr * 16]) add(from, from + dr * 16);
          }
          for (const dc of [-1, 1]) {
            if (!inside(r + dr, c + dc)) continue;
            const to = next + dc, target = this.board[to];
            if (color(target) === other(side) && target.toLowerCase() !== 'k') add(from, to);
            if (!target && to === this.ep && r === (side === 'w' ? 3 : 4)
                && this.board[to - dr * 8] === (side === 'w' ? 'p' : 'P')) add(from, to, {enPassant: true});
          }
        } else {
          const directions = type === 'n' ? knights : rays;
          for (let d = 0; d < directions.length; d++) {
            if ((type === 'b' && d < 4) || (type === 'r' && d >= 4)) continue;
            const [dr, dc] = directions[d];
            for (let n = 1; inside(r + dr * n, c + dc * n); n++) {
              const to = (r + dr * n) * 8 + c + dc * n, target = this.board[to];
              if (color(target) === side || (target && target.toLowerCase() === 'k')) break;
              add(from, to);
              if (target || type === 'k' || type === 'n') break;
            }
          }
          if (type === 'k' && from === (side === 'w' ? 60 : 4) && !this.inCheck()) {
            for (const kingside of [true, false]) {
              const right = side === 'w' ? (kingside ? 'K' : 'Q') : (kingside ? 'k' : 'q');
              const rook = from + (kingside ? 3 : -4), step = kingside ? 1 : -1;
              if (!this.castling.includes(right) || this.board[rook] !== (side === 'w' ? 'R' : 'r')) continue;
              const path = kingside ? [1, 2] : [-1, -2, -3];
              if (path.some(offset => this.board[from + offset])) continue;
              // Test the transit square with the king moved out of its starting square.
              const transit = this.clone();
              transit.board[from] = null;
              transit.board[from + step] = p;
              if (!transit.inCheck(side)) add(from, from + step * 2, {castle: true});
            }
          }
        }
      }
      return moves;
    }

    apply(move) {
      // Internal only. Call move() for validation at the public boundary.
      const {from, to} = move, p = this.board[from];
      if (move.enPassant) this.board[to + (this.turn === 'w' ? 8 : -8)] = null;
      this.board[from] = null;
      this.board[to] = move.promotion ? (this.turn === 'w' ? move.promotion.toUpperCase() : move.promotion) : p;
      if (move.castle) {
        const rookFrom = from + (to > from ? 3 : -4), rookTo = from + (to > from ? 1 : -1);
        this.board[rookTo] = this.board[rookFrom];
        this.board[rookFrom] = null;
      }
      if (p.toLowerCase() === 'k') {
        this.castling = this.castling.replace(this.turn === 'w' ? /[KQ]/g : /[kq]/g, '');
      }
      for (const [square, right] of [[0, 'q'], [7, 'k'], [56, 'Q'], [63, 'K']]) {
        if (from === square || to === square) this.castling = this.castling.replace(right, '');
      }
      this.ep = p.toLowerCase() === 'p' && Math.abs(to - from) === 16 ? (from + to) / 2 : null;
      this.turn = other(this.turn);
    }

    legalMoves() {
      return this.pseudoMoves().filter(move => {
        const next = this.clone();
        next.apply(move);
        return !next.inCheck(this.turn);
      });
    }

    move(uci) {
      if (typeof uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return false;
      const from = index(uci.slice(0, 2)), to = index(uci.slice(2, 4)), promotion = uci[4] || 'q';
      const move = this.legalMoves().find(m => m.from === from && m.to === to && (!m.promotion || m.promotion === promotion));
      if (!move) return false;
      this.apply(move);
      return true;
    }

    status() {
      const check = this.inCheck();
      if (!this.legalMoves().length) return {type: check ? 'checkmate' : 'stalemate', winner: check ? other(this.turn) : null};
      return {type: check ? 'check' : 'playing', winner: null};
    }

    perft(depth) {
      if (depth === 0) return 1;
      const moves = this.legalMoves();
      if (depth === 1) return moves.length;
      let count = 0;
      for (const move of moves) {
        const next = this.clone();
        next.apply(move);
        count += next.perft(depth - 1);
      }
      return count;
    }
  }
  const api = {Chess};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChessEngine = api;
})(globalThis);
