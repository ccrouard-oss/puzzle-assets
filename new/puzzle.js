// puzzle.js
export class OceanPuzzle {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Options
    this.rows = opts.rows ?? 5;
    this.cols = opts.cols ?? 10;
    this.viewPadding = opts.viewPadding ?? 24;
    this.maxStepPerFrame = opts.maxStepPerFrame ?? 10;
    this.dragLerp = opts.dragLerp ?? 0.2;
    this.snapDistance = opts.snapDistance ?? 14;
    this.lockOnSnap = opts.lockOnSnap ?? true;
    this.noOverlap = opts.noOverlap ?? true;

    this.imageUrl = opts.imageUrl;  // 4:3 portrait
    this.soundUrl = opts.soundUrl;

    // State
    this.image = new Image();
    this.pieces = [];
    this.groups = new Map();
    this.pieceToGroup = new Map();
    this.drag = null;
    this.pointer = {x:0, y:0, down:false};
    this.bounds = {x:0,y:0,w:canvas.width,h:canvas.height};
    this.cell = {w:0, h:0};
    this._raf = 0;
    this._running = false;

    // events
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
  }

  async init() {
    const [img, audio] = await Promise.all([
      this._loadImage(this.imageUrl),
      this.soundUrl ? this._loadAudio(this.soundUrl) : null
    ]);
    this.image = img;
    this.clickSound = audio;

    // Respect strict du format 4:3 portrait
    const innerW = this.canvas.width - this.viewPadding*2;
    const innerH = this.canvas.height - this.viewPadding*2;
    const scale = Math.min(innerW / this.image.width, innerH / this.image.height);
    const drawW = Math.round(this.image.width * scale);
    const drawH = Math.round(this.image.height * scale);
    const ox = Math.floor((this.canvas.width - drawW) / 2);
    const oy = Math.floor((this.canvas.height - drawH) / 2);

    this.cell.w = Math.floor(drawW / this.cols);
    this.cell.h = Math.floor(drawH / this.rows);
    this.bounds = {x: ox, y: oy, w: this.cell.w * this.cols, h: this.cell.h * this.rows};

    this._createPieces();
    this._createGroups();
  }

  start() {
    if (this._running) return;
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      this._update();
      this._draw();
    };
    loop();
  }
  stop() { this._running = false; cancelAnimationFrame(this._raf); }

  reset() {
    for (const g of this.groups.values()) { g.pos.x = 0; g.pos.y = 0; }
  }

  shuffle() {
    const cx = this.canvas.width/2, cy = this.canvas.height/2;
    const radius = Math.min(this.canvas.width, this.canvas.height) * 0.28;

    for (const g of this.groups.values()) {
      const a = Math.random()*Math.PI*2;
      const r = Math.random()*radius;
      const gx = cx + Math.cos(a)*r;
      const gy = cy + Math.sin(a)*r;
      const firstId = [...g.members][0];
      const fp = this._pieceById(firstId);
      g.pos.x = gx - fp.target.x;
      g.pos.y = gy - fp.target.y;
    }
    if (this.noOverlap) this._separateGroups();
  }

  _createPieces() {
    this.pieces.length = 0;
    let id = 0;
    for (let r=0; r<this.rows; r++) {
      for (let c=0; c<this.cols; c++) {
        const x = this.bounds.x + c*this.cell.w;
        const y = this.bounds.y + r*this.cell.h;

        const pathFn = (ctx) => {
          const W = this.cell.w, H = this.cell.h, N = 5;
          ctx.beginPath();
          ctx.moveTo(0,0);
          // haut ondulé
          for (let i=1;i<=N;i++){
            const t=i/N, px=t*W, py= 6*Math.sin(t*Math.PI*2 + (r*13+c*7))*0.5;
            ctx.lineTo(px, py);
          }
          // droite ondulée
          for (let i=1;i<=N;i++){
            const t=i/N, px=W + 6*Math.sin(t*Math.PI*2 + (r*17+c*11))*0.5, py=t*H;
            ctx.lineTo(px, py);
          }
          // bas ondulé
          for (let i=1;i<=N;i++){
            const t=i/N, px=W - t*W, py=H + 6*Math.sin(t*Math.PI*2 + (r*19+c*5))*0.5;
            ctx.lineTo(px, py);
          }
          // gauche ondulée
          for (let i=1;i<=N;i++){
            const t=i/N, px=0 + 6*Math.sin(t*Math.PI*2 + (r*23+c*3))*0.5, py=H - t*H;
            ctx.lineTo(px, py);
          }
          ctx.closePath();
        };

        this.pieces.push({
          id: id++,
          r, c,
          target: { x, y },
          size: { w: this.cell.w, h: this.cell.h },
          pathFn
        });
      }
    }
  }

  _createGroups() {
    this.groups.clear();
    this.pieceToGroup.clear();
    for (const p of this.pieces) {
      const gid = self.crypto ? crypto.randomUUID() : String(Math.random());
      this.groups.set(gid, { id: gid, members: new Set([p.id]), pos:{x:0,y:0} });
      this.pieceToGroup.set(p.id, gid);
    }
  }

  onDown = (e) => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    this.pointer = {x, y, down:true};

    const hit = this._hitTest(x,y);
    if (!hit) return;

    const gid = this.pieceToGroup.get(hit.id);
    const g = this.groups.get(gid);
    const world = this._pieceWorldPos(hit.id);
    this.drag = {
      groupId: gid,
      offsetX: x - world.x,
      offsetY: y - world.y,
      target: { x: g.pos.x, y: g.pos.y }
    };

    // bring to front
    const members = new Set(g.members);
    this.groups.delete(gid);
    this.groups.set(gid, { id: gid, members, pos:{x:g.pos.x, y:g.pos.y} });

    this.canvas.setPointerCapture(e.pointerId);
  }

  onMove = (e) => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    this.pointer.x = x; this.pointer.y = y;

    if (this.drag) {
      const desiredX = x - this.drag.offsetX;
      const desiredY = y - this.drag.offsetY;
      this.drag.target.x = desiredX;
      this.drag.target.y = desiredY;
    }
  }

  onUp = (e) => {
    this.pointer.down = false;
    if (!this.drag) return;
    const movedG = this.groups.get(this.drag.groupId);
    this._trySnapAndMerge(movedG);
    this.drag = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
  }

  _update() {
    if (this.drag) {
      const g = this.groups.get(this.drag.groupId);
      const tx = this.drag.target.x;
      const ty = this.drag.target.y;
      let dx = (tx - g.pos.x) * this.dragLerp;
      let dy = (ty - g.pos.y) * this.dragLerp;
      const len = Math.hypot(dx,dy);
      if (len > this.maxStepPerFrame) {
        const s = this.maxStepPerFrame / (len || 1);
        dx *= s; dy *= s;
      }
      g.pos.x += dx; g.pos.y += dy;
    }
  }

  _draw() {
    const ctx = this.ctx;
    ctx.clearRect(0,0,this.canvas.width,this.canvas.height);

    // plateau
    ctx.save();
    ctx.fillStyle = '#fdfdfd';
    ctx.fillRect(this.bounds.x, this.bounds.y, this.bounds.w, this.bounds.h);
    ctx.restore();

    for (const g of this.groups.values()) {
      for (const pid of g.members) {
        const p = this._pieceById(pid);
        const wx = p.target.x + g.pos.x;
        const wy = p.target.y + g.pos.y;

        ctx.save();
        ctx.translate(wx, wy);
        p.pathFn(ctx);
        ctx.clip();

        // source rect sur l'image
        const sx = (p.c)*this.cell.w / (this.bounds.w) * this.image.width;
        const sy = (p.r)*this.cell.h / (this.bounds.h) * this.image.height;
        const sw = this.image.width / this.cols;
        const sh = this.image.height / this.rows;

        ctx.drawImage(this.image, sx, sy, sw, sh, 0, 0, this.cell.w, this.cell.h);
        ctx.restore();

        // contour
        ctx.save();
        ctx.translate(wx, wy);
        p.pathFn(ctx);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,.15)';
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  _pieceById(id){ return this.pieces.find(p=>p.id===id); }

  _pieceWorldPos(id){
    const p = this._pieceById(id);
    const gid = this.pieceToGroup.get(id);
    const g = this.groups.get(gid);
    return { x: p.target.x + g.pos.x, y: p.target.y + g.pos.y };
    }

  _hitTest(x,y){
    const groups = Array.from(this.groups.values());
    for (let gi=groups.length-1; gi>=0; gi--){
      const g = groups[gi];
      const members = Array.from(g.members).map(id=>this._pieceById(id));
      for (let i=members.length-1; i>=0; i--){
        const p = members[i];
        const wx = p.target.x + g.pos.x;
        const wy = p.target.y + g.pos.y;

        this.ctx.save();
        this.ctx.translate(wx, wy);
        p.pathFn(this.ctx);
        const hit = this.ctx.isPointInPath(x - wx, y - wy);
        this.ctx.restore();
        if (hit) return p;
      }
    }
    return null;
  }

  _separateGroups(iter=2){
    const arr = Array.from(this.groups.values());
    for (let k=0;k<iter;k++){
      for (let i=0;i<arr.length;i++){
        for (let j=i+1;j<arr.length;j++){
          const g1 = arr[i], g2 = arr[j];
          const p1 = this._pieceById([...g1.members][0]);
          const p2 = this._pieceById([...g2.members][0]);
          const x1 = p1.target.x + g1.pos.x, y1 = p1.target.y + g1.pos.y;
          const x2 = p2.target.x + g2.pos.x, y2 = p2.target.y + g2.pos.y;
          const dx = x2-x1, dy = y2-y1, d = Math.hypot(dx,dy);
          const minD = Math.min(this.cell.w, this.cell.h)*0.8;
          if (d < minD && d>0){
            const push = (minD-d)/2;
            const nx = dx/d, ny = dy/d;
            g1.pos.x -= nx*push; g1.pos.y -= ny*push;
            g2.pos.x += nx*push; g2.pos.y += ny*push;
          }
        }
      }
    }
  }

  _trySnapAndMerge(movedG){
    let merged = false;
    for (const pid of movedG.members) {
      const p = this._pieceById(pid);
      const neigh = [
        this._getPiece(p.r, p.c-1),
        this._getPiece(p.r, p.c+1),
        this._getPiece(p.r-1, p.c),
        this._getPiece(p.r+1, p.c)
      ].filter(Boolean);

      for (const q of neigh) {
        const gidQ = this.pieceToGroup.get(q.id);
        if (gidQ === movedG.id) continue;
        const gQ = this.groups.get(gidQ);

        const idealX = (q.target.x + gQ.pos.x) - (p.target.x);
        const idealY = (q.target.y + gQ.pos.y) - (p.target.y);
        const dx = idealX - movedG.pos.x;
        const dy = idealY - movedG.pos.y;

        if (Math.hypot(dx,dy) <= this.snapDistance) {
          movedG.pos.x = idealX;
          movedG.pos.y = idealY;
          this._mergeGroups(movedG, gQ);
          merged = true;
          if (this.clickSound) { try { this.clickSound.currentTime = 0; this.clickSound.play(); } catch{} }
          break;
        }
      }
      if (merged && this.lockOnSnap) break;
    }
  }

  _mergeGroups(gA, gB){
    const base = (gB.members.size >= gA.members.size) ? gB : gA;
    const add  = (base === gB) ? gA : gB;
    for (const pid of add.members) {
      base.members.add(pid);
      this.pieceToGroup.set(pid, base.id);
    }
    this.groups.delete(add.id);
  }

  _getPiece(r,c){
    if (r<0||c<0||r>=this.rows||c>=this.cols) return null;
    return this.pieces[r*this.cols + c];
  }

  _loadImage(url){
    return new Promise((res, rej)=>{
      const img = new Image(); img.onload=()=>res(img); img.onerror=rej; img.src=url;
    });
  }
  _loadAudio(url){
    return new Promise((res)=>{ const a = new Audio(url); a.oncanplaythrough = ()=>res(a); a.src=url; a.load(); });
  }
}
