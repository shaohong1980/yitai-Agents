// Three.js 3D 球状知识图谱 — 科技感球形记忆节点图
// 复用项目内已有的 three.module.js（与 hotspot-earth.js 同一套懒加载策略）。
// 布局：自研轻量 3D 力学（球壳吸附 + 连边弹簧 + 软斥力/碰撞），
// 节点渲染为发光 Sprite，随自转呈现前后景深度，科技感主要来自：
//   · 透明线框球壳（内部节点像悬浮在玻璃星球里）
//   · 大气辉光 + 双层轨道环
//   · 中心核心光晕 + 星尘粒子 + 星空背景
//   · 拖拽旋转 / 拖节点 / 滚轮缩放 / 悬停高亮 / 点击点亮

const THREE_LOCAL = './vendor/three/three.module.js';
const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const THREE_CDN_FALLBACK = 'https://unpkg.com/three@0.160.0/build/three.module.js';

async function loadThree() {
  // P1-10：npm three 优先（打包版 tree-shaking）；源码直载时回退本地 vendor/CDN。
  const sources = [
    () => import('three'),
    () => import(/* @vite-ignore */ THREE_LOCAL),
    () => import(THREE_CDN),
    () => import(THREE_CDN_FALLBACK),
  ]
  for (const s of sources) {
    try { const mod = await s(); if (mod) return mod } catch { /* 尝试下一个 */ }
  }
  throw new Error('three.js 加载失败')
}

// 径向渐变发光贴图（仅用于节点「被使用时」的点亮光晕）
function makeGlowTexture(T) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.26)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new T.CanvasTexture(canvas);
  return tex;
}

// 神经元贴图：中心实色、边缘柔和渐隐（像神经元胞体，非机械硬边圆点）
function makeNeuronTexture(T) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.92)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.38)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new T.CanvasTexture(canvas);
  return tex;
}

function hexToRgb(hex, out = {}) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) { out.r = 0.6; out.g = 0.7; out.b = 1; return out; }
  const n = parseInt(m[1], 16);
  out.r = ((n >> 16) & 255) / 255;
  out.g = ((n >> 8) & 255) / 255;
  out.b = (n & 255) / 255;
  return out;
}

// 把字符串 id 转成稳定哈希（0–1）
function idHash(seed) {
  let h = 2166136261;
  const text = String(seed);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0) / 4294967295;
}

export class KnowledgeSphere {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   *   getNodeColor(d) -> css color
   *   getNodeRadius(d) -> base radius (world units)
   *   getTheme() -> { cool, warm, linkStroke, ... }
   *   onHover(d|null, clientX, clientY)
   *   onClick(d|null)
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.T = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.group = null;        // 节点 + 连线 + 球壳（整体自转）
    this.dustGroup = null;    // 内部星尘（反向缓旋）
    this.nodes = [];
    this.links = [];
    this.spriteMap = new Map(); // nid -> { sprite, material, node }
    this.linkGeo = null;

    // 半径 / 相机（固定比例，始终适配左上角记忆球小窗格，不随节点数剧烈缩放）
    this.radius = 120;
    this.camDist = 340;
    this.camDistMin = 240;
    this.camDistMax = 1000;

    // 力学
    this.alpha = 0;
    this.params = { gravity: 1, repulsion: 1.35, nodeSize: 1 };
    this.physics = {
      shellK: 0.16,
      linkK: 0.05,
      repK: 30,
      minDist: 15,
      damp: 0.86,
    };

    // 高亮/点亮：记录「开始时间 + 顺序延迟 + 持续时长」，支持依次点亮、缓慢恢复
    this.active = new Map();

    // 神经信号（沿连线传播的亮点）
    this.signals = [];
    this._signalTimer = 0;

    // 交互状态
    this.isOrbiting = false;
    this.dragNode = null;
    this.hoverNode = null;
    this.lastPtr = { x: 0, y: 0 };
    this.pointerDown = null;
    this.moved = false;
    this.autoRotate = true;
    this._bound = {};

    this.animFrame = null;
    this._disposed = false;
    this._stepCounter = 0;
    this._time = 0;
    this._lastInteract = 0;
  }

  async init() {
    const T = await loadThree();
    this.T = T;

    // canvas 是替换元素，CSS inset:0 不会拉伸它；以画布实际显示尺寸为准（左上角记忆球小窗格）
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || this.canvas.clientWidth || 280;
    const h = rect.height || this.canvas.clientHeight || 280;

    // ── 场景 / 相机 ─────────────────────────────────────
    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(45, w / h, 0.1, 8000);
    this.camera.position.set(0, 0, this.camDist);

    // ── 渲染器 ──────────────────────────────────────────
    this.renderer = new T.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'low-power', // 装饰性场景，不唤醒独显
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    if (T.SRGBColorSpace) this.renderer.outputColorSpace = T.SRGBColorSpace;
    // 关闭色调映射：保证球上节点颜色与左侧栏图例颜色完全一致（ACES 会压暗/偏色）
    this.renderer.toneMapping = T.NoToneMapping;

    // ── 主组 ────────────────────────────────────────────
    this.group = new T.Group();
    this.scene.add(this.group);

    this._buildShell(T);
    this._buildStars(T);
    this._buildDust(T);

    // ── 事件 ────────────────────────────────────────────
    this._bindEvents();

    // ── 渲染循环 ────────────────────────────────────────
    this._animate();
  }

  _hexColor(css) {
    const { r, g, b } = hexToRgb(css);
    return new this.T.Color(r, g, b);
  }

  _buildShell(T) {
    const theme = this.opts.getTheme?.() || {};
    const cool = this._hexColor(theme.cool || '#4f8cff');
    const warm = this._hexColor(theme.warm || '#ff9f1c');

    // 节点发光 / 神经元用贴图
    this.glowTex = makeGlowTexture(T);
    this.dotTex = makeNeuronTexture(T);

    // 中心能量核：神经网络的神秘「核心」，缓慢呼吸
    const coreMat = new T.SpriteMaterial({
      map: this.glowTex,
      color: warm,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      blending: T.AdditiveBlending,
    });
    this.coreGlow = new T.Sprite(coreMat);
    this.coreGlow.scale.setScalar(this.radius * 0.9);
    this.group.add(this.coreGlow);

    // 远景星云（神秘氛围）
    this._buildNebulae(T, cool, warm);
  }

  _buildNebulae(T, cool, warm) {
    this.nebulaGroup = new T.Group();
    const colors = [cool, warm, this._hexColor('#8fb4ff')];
    for (let i = 0; i < 4; i++) {
      const mat = new T.SpriteMaterial({
        map: this.glowTex,
        color: colors[i % colors.length],
        transparent: true,
        opacity: 0.05,
        depthWrite: false,
        blending: T.AdditiveBlending,
      });
      const sp = new T.Sprite(mat);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = this.radius * (3.2 + Math.random() * 3.5);
      sp.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta)
      );
      sp.scale.setScalar(this.radius * (2.2 + Math.random() * 2));
      this.nebulaGroup.add(sp);
    }
    this.scene.add(this.nebulaGroup);
  }

  _buildStars(T) {
    // 神秘星空：更密、更小、更暗，像星云尘埃而非机械点阵
    const verts = [];
    for (let i = 0; i < 2400; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = this.radius * (4.5 + Math.random() * 6);
      verts.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta)
      );
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(verts, 3));
    const mat = new T.PointsMaterial({ color: 0xffffff, size: 0.6, sizeAttenuation: true, transparent: true, opacity: 0.5 });
    this.stars = new T.Points(geo, mat);
    this.scene.add(this.stars);
  }

  _buildDust(T) {
    this.dustGroup = new T.Group();
    const verts = [];
    for (let i = 0; i < 150; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = this.radius * (0.25 + Math.random() * 1.05);
      verts.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta)
      );
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(verts, 3));
    const mat = new T.PointsMaterial({
      color: 0x8fb4ff,
      size: 1.4,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: this.T.AdditiveBlending,
    });
    this.dust = new T.Points(geo, mat);
    this.dustGroup.add(this.dust);
    this.scene.add(this.dustGroup);
  }

  _bindEvents() {
    const c = this.canvas;
    const onDown = (e) => {
      const p = e.touches ? e.touches[0] : e;
      this.pointerDown = { x: p.clientX, y: p.clientY, t: Date.now(), node: null };
      this.moved = false;
      this.isOrbiting = true;
      this.lastPtr = { x: p.clientX, y: p.clientY };
      this._dragStartFromPointer(p.clientX, p.clientY);
    };
    const onMove = (e) => {
      const p = e.touches ? e.touches[0] : e;
      const px = p.clientX, py = p.clientY;
      if (this.pointerDown && this.dragNode) {
        this.moved = true;
        this._dragNodeTo(px, py);
      } else if (this.pointerDown && this.isOrbiting) {
        const dx = px - this.lastPtr.x;
        const dy = py - this.lastPtr.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
        this.group.rotation.y -= dx * 0.005;
        this.group.rotation.x -= dy * 0.005;
        this.group.rotation.x = Math.max(-1.2, Math.min(1.2, this.group.rotation.x));
        this.lastPtr = { x: px, y: py };
        this.autoRotate = false;
        this._lastInteract = performance.now();
      } else {
        this._hoverAt(px, py);
      }
    };
    const onUp = (e) => {
      const p = e.touches ? e.touches[0] : e;
      if (this.dragNode) {
        const nd = this.dragNode;
        nd.fx = null; nd.fy = null; nd.fz = null;
        // 松手给一点速度，让节点重新参与力学
        nd.vx = nd.vx || 0; nd.vy = nd.vy || 0; nd.vz = nd.vz || 0;
        this.dragNode = null;
        this.alpha = Math.max(this.alpha, 0.35);
      }
      if (this.pointerDown) {
        const ex = p ? p.clientX : this.lastPtr.x;
        const ey = p ? p.clientY : this.lastPtr.y;
        const moved = this.moved || (Math.abs(ex - this.pointerDown.x) + Math.abs(ey - this.pointerDown.y) > 6);
        const node = this.pointerDown.node;
        if (!moved && node) this.opts.onClick ? this.opts.onClick(node) : null;
        this.pointerDown = null;
      }
      this.isOrbiting = false;
      this._lastInteract = performance.now();
    };
    const onWheel = (e) => {
      // 滚轮不缩放球体（保持固定比例适配界面），只阻止页面滚动
      e.preventDefault();
      this._lastInteract = performance.now();
    };
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onUp);
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    this._bound = { onDown, onMove, onUp, onWheel };
  }

  // ── 布局 & 数据 ─────────────────────────────────────────

  _computeRadius() {
    // 球体尺寸适配界面：节点多时半径略增，但封顶，避免溢出侧栏；相机距离按比例拉远，
    // 让球体在屏幕上始终约占 45%–52% 高度，居中且两侧留白。
    const n = this.nodes.length;
    this.radius = Math.max(64, Math.min(130, Math.sqrt(Math.max(1, n)) * 8.5));
    this.camDist = Math.max(this.radius * 4.6, 240);
    this.camDistMin = Math.max(this.radius * 4.0, 220);
    this.camDistMax = this.camDistMin * 2.2;
  }

  _rescaleShellGeometry() {
    const T = this.T;
    if (!T) return;
    const R = this.radius;
    if (this.coreGlow) this.coreGlow.scale.setScalar(R * 0.9);
    // 星星/星尘/星云跟随半径
    if (this.stars) {
      const pos = this.stars.geometry.attributes.position.array;
      for (let i = 0; i < pos.length; i += 3) {
        const len = Math.hypot(pos[i], pos[i + 1], pos[i + 2]);
        const target = R * (4.5 + Math.random() * 6);
        if (len > 1e-4) { pos[i] *= target / len; pos[i + 1] *= target / len; pos[i + 2] *= target / len; }
      }
      this.stars.geometry.attributes.position.needsUpdate = true;
    }
    if (this.dust) {
      const pos = this.dust.geometry.attributes.position.array;
      for (let i = 0; i < pos.length; i += 3) {
        const len = Math.hypot(pos[i], pos[i + 1], pos[i + 2]);
        const target = R * (0.25 + Math.random() * 1.05);
        if (len > 1e-4) { pos[i] *= target / len; pos[i + 1] *= target / len; pos[i + 2] *= target / len; }
      }
      this.dust.geometry.attributes.position.needsUpdate = true;
    }
    if (this.nebulaGroup) {
      const n = this.nebulaGroup.children.length;
      for (let i = 0; i < n; i++) {
        const sp = this.nebulaGroup.children[i];
        sp.scale.setScalar(R * (2.2 + (i % 3) * 0.9));
      }
    }
  }

  _seedPosition(node) {
    // 斐波那契球面分布，但落在「壳层带」内（0.78R–1.15R），形成有机的神经网络云团而非薄壳
    const R = this.radius;
    const idx = Math.floor(idHash(node._nid) * 100000);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const y = 1 - (idx / 100000) * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * idx;
    const r = R * (0.78 + Math.random() * 0.37);
    node.x = Math.cos(theta) * rad * r;
    node.y = y * r;
    node.z = Math.sin(theta) * rad * r;
    node.vx = 0; node.vy = 0; node.vz = 0;
  }

  _syncNodeMeshes() {
    const T = this.T;
    const seen = new Set();
    this.nodes.forEach((node) => {
      const key = String(node._nid);
      seen.add(key);
      let entry = this.spriteMap.get(key);
      if (!entry) {
        // 节点 = 平色圆点（默认不发光，颜色与左侧图例一一对应）
        const dotMat = new T.SpriteMaterial({
          map: this.dotTex,
          color: new T.Color(0.6, 0.7, 1),
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
        });
        const dot = new T.Sprite(dotMat);
        dot.userData.nid = node._nid;
        dot.userData.kind = 'dot';
        this.group.add(dot);
        // 光晕 = 被使用时才显示（默认隐藏）
        const glowMat = new T.SpriteMaterial({
          map: this.glowTex,
          color: new T.Color(1, 1, 1),
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: T.AdditiveBlending,
        });
        const glow = new T.Sprite(glowMat);
        glow.userData.nid = node._nid;
        glow.userData.kind = 'glow';
        glow.visible = false;
        this.group.add(glow);
        entry = { dot, glow, dotMat, glowMat, node };
        this.spriteMap.set(key, entry);
        // 新节点：初始位置球面分布
        if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.z)) {
          this._seedPosition(node);
        }
      } else {
        entry.node = node;
      }
    });
    // 移除已不存在的
    this.spriteMap.forEach((entry, key) => {
      if (!seen.has(key)) {
        this.group.remove(entry.dot);
        this.group.remove(entry.glow);
        entry.dotMat.dispose();
        entry.glowMat.dispose();
        this.spriteMap.delete(key);
      }
    });
  }

  // 神经纤维：二阶贝塞尔，控制点=中点沿半径外推（像神经轴突在云团外缘拱起）
  _linkControl(s, t) {
    const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2, mz = (s.z + t.z) / 2;
    const len = Math.hypot(t.x - s.x, t.y - s.y, t.z - s.z);
    const mlen = Math.hypot(mx, my, mz) || 1;
    const bulge = len * 0.26;
    return [mx + (mx / mlen) * bulge, my + (my / mlen) * bulge, mz + (mz / mlen) * bulge];
  }

  _bezierAt(a, c, b, u) {
    const inv = 1 - u;
    return [
      inv * inv * a[0] + 2 * inv * u * c[0] + u * u * b[0],
      inv * inv * a[1] + 2 * inv * u * c[1] + u * u * b[1],
      inv * inv * a[2] + 2 * inv * u * c[2] + u * u * b[2],
    ];
  }

  _rebuildLinks() {
    const T = this.T;
    if (this.linkGeo) {
      this.group.remove(this.linkLines);
      this.linkGeo.dispose();
      this.linkLines.material.dispose();
    }
    const count = this.links.length;
    const SEG = 10; // 每根纤维的曲线分段
    const positions = new Float32Array(count * SEG * 2 * 3);
    const colors = new Float32Array(count * SEG * 2 * 3);
    this.linkGeo = new T.BufferGeometry();
    this.linkGeo.setAttribute('position', new T.BufferAttribute(positions, 3));
    this.linkGeo.setAttribute('color', new T.BufferAttribute(colors, 3));
    const mat = new T.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: T.AdditiveBlending,
    });
    this.linkLines = new T.LineSegments(this.linkGeo, mat);
    this.group.add(this.linkLines);
    // 神经信号点（沿纤维传播的亮点）
    if (!this.signalPoints) {
      const MAX = 26;
      const sp = new Float32Array(MAX * 3);
      const sigGeo = new T.BufferGeometry();
      sigGeo.setAttribute('position', new T.BufferAttribute(sp, 3));
      const sigMat = new T.PointsMaterial({
        map: this.glowTex,
        color: 0xffffff,
        size: 2.6,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: T.AdditiveBlending,
      });
      this.signalPoints = new T.Points(sigGeo, sigMat);
      this.signalPoints.frustumCulled = false;
      this.signalPoints.visible = false;
      this.group.add(this.signalPoints);
    }
  }

  _writeLinkPositions() {
    const pos = this.linkGeo ? this.linkGeo.attributes.position.array : null;
    if (!pos) return;
    const colors = this.linkGeo.attributes.color.array;
    const col = { r: 0, g: 0, b: 0 };
    const SEG = 10;
    for (let i = 0; i < this.links.length; i++) {
      const l = this.links[i];
      const s = l.source, t = l.target;
      if (!s || !t) continue;
      const ctrl = this._linkControl(s, t);
      l._ctrl = ctrl; // 供信号复用
      const alphaC = l._kind === 'visual_parent' ? 0.5
        : l._kind === 'visual_random' ? 0.16
        : 0.34;
      hexToRgb(l._color || '#8fb6d8', col);
      const base = i * SEG * 2 * 3;
      for (let seg = 0; seg < SEG; seg++) {
        const u1 = seg / SEG, u2 = (seg + 1) / SEG;
        const p1 = this._bezierAt([s.x, s.y, s.z], ctrl, [t.x, t.y, t.z], u1);
        const p2 = this._bezierAt([s.x, s.y, s.z], ctrl, [t.x, t.y, t.z], u2);
        const o = base + seg * 6;
        pos[o] = p1[0]; pos[o + 1] = p1[1]; pos[o + 2] = p1[2];
        pos[o + 3] = p2[0]; pos[o + 4] = p2[1]; pos[o + 5] = p2[2];
        colors[o] = col.r * alphaC; colors[o + 1] = col.g * alphaC; colors[o + 2] = col.b * alphaC;
        colors[o + 3] = col.r * alphaC; colors[o + 4] = col.g * alphaC; colors[o + 5] = col.b * alphaC;
      }
    }
    this.linkGeo.attributes.position.needsUpdate = true;
    this.linkGeo.attributes.color.needsUpdate = true;
  }

  // 神经信号：沿纤维传播的亮点，模拟神经网络放电
  _spawnSignal(link, fromEnd = 0) {
    if (!link || !link.source || !link.target) return;
    if (this.signals.length >= 26) return;
    this.signals.push({
      link,
      u: fromEnd,
      dir: fromEnd > 0 ? -1 : 1,
      speed: 0.006 + Math.random() * 0.006,
    });
  }

  _updateSignals() {
    const now = Date.now();
    // 周期性地随机点燃一条纤维
    if (this.signals.length < 8 && now - this._signalTimer > 260) {
      this._signalTimer = now;
      const link = this.links[Math.floor(Math.random() * this.links.length)];
      if (link) this._spawnSignal(link);
    }
    // 推进 + 回收
    for (let i = this.signals.length - 1; i >= 0; i--) {
      const sg = this.signals[i];
      sg.u += sg.dir * sg.speed;
      if (sg.u < 0 || sg.u > 1) this.signals.splice(i, 1);
    }
    // 写入信号点位置（超出画布的隐藏）
    const buf = this.signalPoints.geometry.attributes.position.array;
    const FAR = 10000;
    for (let i = 0; i < buf.length / 3; i++) {
      const sg = this.signals[i];
      if (!sg) { buf[i * 3] = FAR; buf[i * 3 + 1] = FAR; buf[i * 3 + 2] = FAR; continue; }
      const l = sg.link, s = l.source, t = l.target;
      const ctrl = l._ctrl || this._linkControl(s, t);
      const p = this._bezierAt([s.x, s.y, s.z], ctrl, [t.x, t.y, t.z], Math.max(0, Math.min(1, sg.u)));
      buf[i * 3] = p[0]; buf[i * 3 + 1] = p[1]; buf[i * 3 + 2] = p[2];
    }
    this.signalPoints.geometry.attributes.position.needsUpdate = true;
    this.signalPoints.visible = this.signals.length > 0;
  }

  _resolveLinkRefs() {
    const byId = new Map(this.nodes.map((n) => [String(n._nid), n]));
    this.links.forEach((l) => {
      if (typeof l.source !== 'object') l.source = byId.get(String(l.source));
      if (typeof l.target !== 'object') l.target = byId.get(String(l.target));
    });
    this.links = this.links.filter((l) => l.source && l.target && l.source !== l.target);
  }

  /**
   * 全量设置数据（节点/连线），重建场景并重启布局
   */
  setData(nodes, links, alpha = 1) {
    const firstData = this.nodes.length === 0;
    this.nodes = nodes || [];
    this.links = links || [];
    this._resolveLinkRefs();
    this._computeRadius();
    this._rescaleShellGeometry();
    this._syncNodeMeshes();
    this._rebuildLinks();
    this._writeLinkPositions();
    this.refreshVisuals();

    // 首载 / 缺失位置的节点：球面分布
    this.nodes.forEach((n) => {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.z)) this._seedPosition(n);
    });

    this.alpha = Math.max(this.alpha, firstData ? 1 : Math.min(1, alpha || 0.6));
    this._writeNodeSprites();
    this._writeLinkPositions();
  }

  /**
   * 追加新节点并重建连线
   */
  addNodes(newNodes, links) {
    if (!newNodes || !newNodes.length) return;
    const byId = new Map(this.nodes.map((n) => [String(n._nid), n]));
    newNodes.forEach((n) => {
      if (n._nid && !byId.has(String(n._nid))) {
        byId.set(String(n._nid), n);
        this.nodes.push(n);
      }
    });
    this.links = links || this.links;
    this._computeRadius();
    this._rescaleShellGeometry();
    this._syncNodeMeshes();
    this._rebuildLinks();
    this._writeLinkPositions();
    this.refreshVisuals();
    this.alpha = Math.max(this.alpha, 0.5);
  }

  // 点亮节点：按传入顺序逐个延迟点亮（先召回的先亮），保持明亮后缓慢恢复
  highlight(nids, duration = 2400) {
    const now = Date.now();
    const step = Math.min(200, Math.max(90, Math.floor(duration / Math.max(1, nids.length))));
    nids.forEach((nid, i) => {
      this.active.set(String(nid), { start: now, delay: i * step, duration });
      // 被使用节点向相连的纤维放射神经信号（模拟神经元放电）
      const nidStr = String(nid);
      const linked = this.links.filter(l =>
        (l.source && String(l.source._nid) === nidStr) || (l.target && String(l.target._nid) === nidStr)
      ).slice(0, 4);
      linked.forEach(l => {
        const fromS = l.source && String(l.source._nid) === nidStr;
        this._spawnSignal(l, fromS ? 0 : 1);
      });
    });
  }

  // 点亮强度：0=熄灭 1=最亮。快速点亮(≈250ms) → 保持明亮 → 二次缓出缓慢恢复
  _highlightIntensity(state, now) {
    if (!state) return 0;
    const t = now - (state.start + state.delay);
    const dur = state.duration;
    if (t < 0 || t >= dur) return 0;
    const ramp = Math.min(260, dur * 0.25);
    if (t < ramp) return t / ramp;
    const holdEnd = dur * 0.45;
    if (t < holdEnd) return 1;
    const decay = (t - holdEnd) / Math.max(1, dur - holdEnd);
    return Math.max(0, 1 - decay * decay);
  }

  nudge(nodes) {
    if (!nodes || !nodes.length) return;
    const R = this.radius;
    nodes.forEach((nd) => {
      if (nd.fx != null) return;
      const angle = Math.random() * Math.PI * 2;
      const offset = R * (0.08 + Math.random() * 0.14);
      nd.vx += Math.cos(angle) * offset * 0.08;
      nd.vy += Math.sin(angle) * offset * 0.08;
      nd.vz += (Math.random() - 0.5) * offset * 0.1;
    });
    this.alpha = Math.max(this.alpha, 0.28);
  }

  nudgeAll() {
    if (!this.nodes.length) return;
    this.nodes.forEach((nd) => {
      if (nd.fx == null && !nd._core) {
        nd.vx += (Math.random() - 0.5) * 0.4;
        nd.vy += (Math.random() - 0.5) * 0.4;
        nd.vz += (Math.random() - 0.5) * 0.4;
      }
    });
    this.alpha = Math.max(this.alpha, 0.3);
  }

  setPhysics(params) {
    if (!params) return;
    this.params.gravity = Number(params.gravity) || 1;
    this.params.repulsion = Number(params.repulsion) || 1;
    this.params.nodeSize = Number(params.nodeSize) || 1;
    this.refreshVisuals();
  }

  refreshVisuals() {
    const T = this.T;
    if (!T) return;
    const theme = this.opts.getTheme ? this.opts.getTheme() : {};
    const cool = this._hexColor(theme.cool || '#4f8cff');
    const warm = this._hexColor(theme.warm || '#ff9f1c');
    if (this.coreGlow) this.coreGlow.material.color.copy(warm);
    if (this.nebulaGroup) {
      const colors = [cool, warm, this._hexColor('#8fb4ff')];
      this.nebulaGroup.children.forEach((sp, i) => {
        if (sp.material) sp.material.color.copy(colors[i % colors.length]);
      });
    }

    // 节点着色（神经元与光晕都用同一图例色）
    this.spriteMap.forEach((entry) => {
      const d = entry.node;
      const css = this.opts.getNodeColor ? this.opts.getNodeColor(d) : '#8b95a5';
      entry._rgb = hexToRgb(css, entry._rgb);
      entry.dotMat.color.setRGB(entry._rgb.r, entry._rgb.g, entry._rgb.b);
      entry.glowMat.color.setRGB(entry._rgb.r, entry._rgb.g, entry._rgb.b);
    });
  }

  resetView() {
    this.camDist = Math.max(this.radius * 4.6, 240);
    this.group.rotation.x = 0;
    this.group.rotation.y = 0;
    this.autoRotate = true;
    // 重新摊开布局
    this.nodes.forEach((n) => this._seedPosition(n));
    this._writeNodeSprites();
    this._writeLinkPositions();
    this.alpha = Math.max(this.alpha, 1);
  }

  // ── 交互工具 ───────────────────────────────────────────

  _ndc(px, py) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((px - rect.left) / rect.width) * 2 - 1,
      y: -((py - rect.top) / rect.height) * 2 + 1,
    };
  }

  _pick(px, py) {
    if (!this.raycaster) this.raycaster = new this.T.Raycaster();
    const { x, y } = this._ndc(px, py);
    this.raycaster.setFromCamera({ x, y }, this.camera);
    const sprites = [];
    this.spriteMap.forEach((e) => sprites.push(e.dot));
    const hits = this.raycaster.intersectObjects(sprites, false);
    return hits.length ? hits[0] : null;
  }

  _hoverAt(px, py) {
    const hit = this._pick(px, py);
    const node = hit && hit.object.userData
      ? (this.spriteMap.get(String(hit.object.userData.nid)) || {}).node || null
      : null;
    if (node === this.hoverNode) {
      if (node && this.opts.onHover) this.opts.onHover(node, px, py);
      return;
    }
    this.hoverNode = node;
    this.canvas.style.cursor = node ? 'pointer' : 'grab';
    if (this.opts.onHover) this.opts.onHover(node, px, py);
  }

  _dragStartFromPointer(px, py) {
    const hit = this._pick(px, py);
    if (hit && hit.object.userData) {
      const node = (this.spriteMap.get(String(hit.object.userData.nid)) || {}).node || null;
      if (node && !node._core) {
        this.dragNode = node;
        this.pointerDown.node = node;
        this.canvas.style.cursor = 'grabbing';
        return;
      }
    }
    this.pointerDown.node = null;
  }

  _dragNodeTo(px, py) {
    const T = this.T;
    const nd = this.dragNode;
    if (!nd) return;
    if (!this.raycaster) this.raycaster = new T.Raycaster();
    const { x, y } = this._ndc(px, py);
    this.raycaster.setFromCamera({ x, y }, this.camera);

    // 以节点世界位置为锚点、法向为相机朝向的平面
    const worldPos = new T.Vector3(nd.x, nd.y, nd.z).applyMatrix4(this.group.matrixWorld);
    const camDir = new T.Vector3();
    this.camera.getWorldDirection(camDir);
    const plane = new T.Plane().setFromNormalAndCoplanarPoint(camDir, worldPos);
    const out = new T.Vector3();
    this.raycaster.ray.intersectPlane(plane, out);
    if (!out) return;
    this.group.worldToLocal(out);
    // 限制在球壳附近（让拖拽沿着球面走）
    const R = this.radius;
    const len = out.length();
    if (len > 1e-4) out.multiplyScalar(R / len);
    nd.fx = out.x; nd.fy = out.y; nd.fz = out.z;
    nd.x = out.x; nd.y = out.y; nd.z = out.z;
    this._writeLinkPositions();
  }

  // ── 力学 ────────────────────────────────────────────────

  _linkRest(l) {
    if (l._kind === 'visual_parent') return this.radius * 0.5;
    if (l._kind === 'visual_random') return this.radius * 0.72;
    return this.radius * 0.58;
  }

  _stepPhysics() {
    const nodes = this.nodes;
    const links = this.links;
    const n = nodes.length;
    if (!n) return;
    const R = this.radius;
    const alpha = this.alpha;
    const p = this.physics;
    const grav = this.params.gravity;

    // 引力：决定节点向球心收缩的程度（引力越大 → 节点越聚拢成密实球核，越小 → 铺在球壳表面）
    const shellK = p.shellK * (0.5 + 0.5 * alpha) * (0.8 + 0.4 * grav);
    const targetFactor = Math.max(0.5, 1.0 - 0.1 * grav);
    for (const nd of nodes) {
      if (nd.fx != null) continue;
      let d = Math.hypot(nd.x, nd.y, nd.z);
      if (d < 1e-4) {
        const u = Math.random() * Math.PI * 2;
        const v = Math.acos(2 * Math.random() - 1);
        nd.x = Math.sin(v) * Math.cos(u) * R;
        nd.y = Math.cos(v) * R;
        nd.z = Math.sin(v) * Math.sin(u) * R;
        d = R;
      }
      // 柔和壳层带（0.82R–1.12R）：形成有机神经网络云团，而非机械薄壳
      const target = R * targetFactor * (0.82 + 0.3 * (0.5 + 0.5 * Math.sin(idHash(nd._nid) * 37)));
      const shell = (target - d) * shellK;
      nd.vx += (nd.x / d) * shell;
      nd.vy += (nd.y / d) * shell;
      nd.vz += (nd.z / d) * shell;
    }

    // 连边弹簧（沿弦拉近，让相关节点聚成簇）
    const linkK = p.linkK * (0.3 + 0.7 * alpha);
    for (const l of links) {
      const s = l.source, t = l.target;
      if (s.fx != null && t.fx != null) continue;
      let dx = t.x - s.x, dy = t.y - s.y, dz = t.z - s.z;
      let len = Math.hypot(dx, dy, dz);
      if (len < 1e-4) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = Math.random() - 0.5; len = Math.hypot(dx, dy, dz) || 1; }
      const rest = this._linkRest(l);
      const f = (len - rest) * linkK;
      const fx = (dx / len) * f, fy = (dy / len) * f, fz = (dz / len) * f;
      if (s.fx == null) { s.vx += fx; s.vy += fy; s.vz += fz; }
      if (t.fx == null) { t.vx -= fx; t.vy -= fy; t.vz -= fz; }
    }

    // 斥力：越大节点间距越开、分布越均匀，越小越容易扎堆（布局阶段有效）
    if (alpha > 0.03 && n <= 1000) {
      const repK = p.repK * this.params.repulsion * (0.25 + 0.75 * alpha);
      const minDist = p.minDist * (0.6 + 0.2 * this.params.repulsion);
      this._stepCounter += 1;
      const doRep = n > 600 ? (this._stepCounter % 3 === 0) : true;
      if (doRep) {
        for (let i = 0; i < n; i++) {
          const a = nodes[i];
          if (a.fx != null) continue;
          for (let j = i + 1; j < n; j++) {
            const b = nodes[j];
            if (b.fx != null) continue;
            const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < 1e-6 || d2 > minDist * minDist * 8) continue;
            const dist = Math.sqrt(d2);
            const force = repK / Math.max(d2, 0.6);
            const fx = (dx / dist) * force, fy = (dy / dist) * force, fz = (dz / dist) * force;
            a.vx -= fx; a.vy -= fy; a.vz -= fz;
            b.vx += fx; b.vy += fy; b.vz += fz;
            if (dist < minDist) {
              const push = (minDist - dist) * 0.45 * alpha;
              const px = (dx / dist) * push, py = (dy / dist) * push, pz = (dz / dist) * push;
              a.x -= px; a.y -= py; a.z -= pz;
              b.x += px; b.y += py; b.z += pz;
            }
          }
        }
      }
    }

    // 积分 + 阻尼 + 限速
    const damp = p.damp;
    for (const nd of nodes) {
      if (nd.fx != null) continue;
      nd.vx *= damp; nd.vy *= damp; nd.vz *= damp;
      const sp = Math.hypot(nd.vx, nd.vy, nd.vz);
      if (sp > 5) { const s = 5 / sp; nd.vx *= s; nd.vy *= s; nd.vz *= s; }
      nd.x += nd.vx; nd.y += nd.vy; nd.z += nd.vz;
    }

    this.alpha *= 0.985;
    if (this.alpha < 0.02) this.alpha = 0;
  }

  // ── 每帧更新 ────────────────────────────────────────────

  _writeNodeSprites() {
    const T = this.T;
    const now = Date.now();
    const tmp = new T.Vector3();
    const camPos = this.camera.position;
    const R = this.radius;

    this.spriteMap.forEach((entry) => {
      const d = entry.node;
      if (!d) return;
      // 静态位置（不做呼吸闪烁，只有被使用时才点亮）
      entry.dot.position.set(d.x, d.y, d.z);
      entry.glow.position.set(d.x, d.y, d.z);

      // 世界坐标 → 深度（前大后小、前亮后暗）
      tmp.set(d.x, d.y, d.z).applyMatrix4(this.group.matrixWorld);
      tmp.sub(camPos);
      const depth = Math.max(0, Math.min(1, 1 - (tmp.length() - this.camDist) / (R * 2.2)));

      // 基础半径（神经元胞体）
      const base = this.opts.getNodeRadius ? this.opts.getNodeRadius(d) : 3.5;
      const nid = String(d._nid);
      const state = this.active.get(nid);
      const intensity = this._highlightIntensity(state, now);
      if (state && intensity <= 0) this.active.delete(nid);

      // 神经元缓慢呼吸：每个节点相位/频率不同（±6%），像神经网络在休息时的活性，不刺眼
      const breath = 1 + 0.06 * Math.sin(now * 0.0012 * (0.7 + idHash(d._nid) * 0.8) + idHash(d._nid) * 6.283);
      const hoverBoost = this.hoverNode === d ? 1.18 : 1;
      const useBoost = 1 + 0.35 * intensity;
      const s = base * 2.1 * this.params.nodeSize * (0.62 + 0.42 * depth) * breath * useBoost * hoverBoost;
      entry.dot.scale.setScalar(Math.max(0.5, s));
      const dotOpacity = 0.95 * (0.34 + 0.66 * depth) + 0.12 * intensity;
      entry.dotMat.opacity = Math.max(0.12, dotOpacity);

      // 光晕：默认隐藏，只有「被使用」时才点亮（加法发光），强度随点亮曲线走
      if (intensity > 0) {
        entry.glow.visible = true;
        entry.glow.scale.setScalar(Math.max(1, s * (2.0 + 0.8 * intensity)));
        entry.glowMat.opacity = Math.max(0.08, intensity * (0.75 + 0.25 * depth));
      } else {
        entry.glow.visible = false;
      }
    });
  }

  _animate() {
    if (this._disposed) return;
    this.animFrame = requestAnimationFrame(() => this._animate());
    this._time += 1;

    // 布局
    if (this.alpha > 0) this._stepPhysics();

    // 自转
    const now = performance.now();
    if (this.isOrbiting) this.autoRotate = false;
    else if (!this.dragNode && now - (this._lastInteract || 0) > 2400) this.autoRotate = true;
    if (this.autoRotate && !this.isOrbiting && !this.dragNode) {
      this.group.rotation.y += 0.0012 * (0.6 + 0.6 * this.params.gravity);
    }

    // 星尘微旋 + 星云缓转
    if (this.dustGroup) this.dustGroup.rotation.y -= 0.0004;
    if (this.nebulaGroup) this.nebulaGroup.rotation.y += 0.00012;

    // 中心能量核缓慢呼吸
    if (this.coreGlow) {
      const breathe = 0.82 + 0.18 * Math.sin(now * 0.0008);
      this.coreGlow.material.opacity = 0.09 + 0.07 * breathe;
    }

    // 节点 & 连线 & 神经信号
    if (this.spriteMap.size) this._writeNodeSprites();
    if (this.linkGeo) {
      if (this.alpha > 0 || this.signals.length) this._writeLinkPositions();
      this._updateSignals();
    }

    // 相机距离平滑
    const curr = this.camera.position.length();
    const next = curr + (this.camDist - curr) * 0.08;
    this.camera.position.setLength(Math.max(0.1, next));

    this._checkResize();
    this.renderer.render(this.scene, this.camera);
  }

  _checkResize() {
    const c = this.canvas;
    const rect = c.getBoundingClientRect();
    const w = rect.width || c.clientWidth;
    const h = rect.height || c.clientHeight;
    if (!w || !h) return;
    const dpr = this.renderer.getPixelRatio();
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  pause() {
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
  }

  resume() {
    if (!this.animFrame && !this._disposed) this._animate();
  }

  dispose() {
    this._disposed = true;
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    const c = this.canvas;
    const b = this._bound;
    if (b.onDown) c.removeEventListener('pointerdown', b.onDown);
    if (b.onMove) c.removeEventListener('pointermove', b.onMove);
    if (b.onUp) {
      c.removeEventListener('pointerup', b.onUp);
      c.removeEventListener('pointercancel', b.onUp);
    }
    if (b.onWheel) c.removeEventListener('wheel', b.onWheel);
    this.renderer ? this.renderer.dispose() : null;
    this.renderer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2D Canvas 回退渲染器 —— WebGL 不可用（无 GPU / 远程桌面 / 虚拟机等）时，
// 用纯 2D canvas 把同一个 3D 球体手动投影绘制，保证任何环境都能看到球形图谱。
// 与 KnowledgeSphere 共享同一套数据/力学/交互语义，仅渲染方式不同。
// ═══════════════════════════════════════════════════════════════════════════
export class KnowledgeSphere2D {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.ctx = null;
    this.nodes = [];
    this.links = [];
    this.nodeMap = new Map(); // nid -> node
    this.active = new Map();

    this.radius = 120;
    this.camDist = 340;
    this.alpha = 0;
    this.params = { gravity: 1, repulsion: 1.35, nodeSize: 1 };
    this.physics = { shellK: 0.16, linkK: 0.05, repK: 30, minDist: 15, damp: 0.86 };

    this.rotX = 0;
    this.rotY = 0;
    this.autoRotate = true;
    this.isOrbiting = false;
    this.dragNode = null;
    this.hoverNode = null;
    this.pointerDown = null;
    this.lastPtr = { x: 0, y: 0 };
    this.moved = false;
    this.stars = [];
    this._bound = {};

    this.animFrame = null;
    this._disposed = false;
    this._time = 0;
    this._lastInteract = 0;
  }

  async init() {
    const canvas = this.canvas;
    // canvas 是替换元素，CSS inset:0 不会拉伸它；以画布实际显示尺寸为准（左上角记忆球小窗格）
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || canvas.clientWidth || 280;
    const h = rect.height || canvas.clientHeight || 280;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    this._dpr = dpr;
    this._W = w;
    this._H = h;
    this.ctx = canvas.getContext('2d');

    // 星空（静态二维点）
    for (let i = 0; i < 420; i++) {
      this.stars.push({
        x: Math.random(),
        y: Math.random(),
        r: 0.4 + Math.random() * 1.2,
        a: 0.25 + Math.random() * 0.6,
      });
    }

    this._bindEvents();
    this._animate();
  }

  _bindEvents() {
    const c = this.canvas;
    const onDown = (e) => {
      const p = e.touches ? e.touches[0] : e;
      this.pointerDown = { x: p.clientX, y: p.clientY, t: Date.now(), node: null };
      this.moved = false;
      this.isOrbiting = true;
      this.lastPtr = { x: p.clientX, y: p.clientY };
      // 命中节点则进入节点拖拽
      const hit = this._pickNode(p.clientX, p.clientY);
      if (hit && !hit._core) { this.dragNode = hit; this.pointerDown.node = hit; }
    };
    const onMove = (e) => {
      const p = e.touches ? e.touches[0] : e;
      const px = p.clientX, py = p.clientY;
      if (this.dragNode) {
        this.moved = true;
        this._dragNodeTo(px, py);
      } else if (this.pointerDown && this.isOrbiting) {
        const dx = px - this.lastPtr.x;
        const dy = py - this.lastPtr.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;
        this.rotY -= dx * 0.005;
        this.rotX -= dy * 0.005;
        this.rotX = Math.max(-1.2, Math.min(1.2, this.rotX));
        this.lastPtr = { x: px, y: py };
        this.autoRotate = false;
        this._lastInteract = performance.now();
      } else {
        this._hoverAt(px, py);
      }
    };
    const onUp = (e) => {
      const p = e.touches ? e.touches[0] : e;
      if (this.dragNode) {
        const nd = this.dragNode;
        nd.fx = null; nd.fy = null; nd.fz = null;
        this.dragNode = null;
        this.alpha = Math.max(this.alpha, 0.35);
      }
      if (this.pointerDown) {
        const ex = p ? p.clientX : this.lastPtr.x;
        const ey = p ? p.clientY : this.lastPtr.y;
        const moved = this.moved || (Math.abs(ex - this.pointerDown.x) + Math.abs(ey - this.pointerDown.y) > 6);
        if (!moved && this.pointerDown.node) this.opts.onClick ? this.opts.onClick(this.pointerDown.node) : null;
        this.pointerDown = null;
      }
      this.isOrbiting = false;
      this._lastInteract = performance.now();
    };
    const onWheel = (e) => { e.preventDefault(); this._lastInteract = performance.now(); };
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onUp);
    c.addEventListener('wheel', onWheel, { passive: false });
    this._bound = { onDown, onMove, onUp, onWheel };
  }

  // ── 布局 & 数据 ─────────────────────────────────────────

  _computeRadius() {
    const n = this.nodes.length;
    this.radius = Math.max(64, Math.min(130, Math.sqrt(Math.max(1, n)) * 8.5));
    this.camDist = Math.max(this.radius * 4.6, 240);
  }

  _seedPosition(node) {
    const R = this.radius;
    const h = idHash(node._nid);
    const phi = Math.acos(2 * h - 1);
    const theta = Math.PI * (3 - Math.sqrt(5)) * Math.floor(h * 100000);
    const r = R * (0.9 + Math.random() * 0.18);
    node.x = Math.sin(phi) * Math.cos(theta) * r;
    node.y = Math.cos(phi) * r;
    node.z = Math.sin(phi) * Math.sin(theta) * r;
    node.vx = 0; node.vy = 0; node.vz = 0;
  }

  _linkRest(l) {
    if (l._kind === 'visual_parent') return this.radius * 0.5;
    if (l._kind === 'visual_random') return this.radius * 0.72;
    return this.radius * 0.58;
  }

  _resolveLinkRefs() {
    const byId = this.nodeMap;
    this.links.forEach((l) => {
      if (typeof l.source !== 'object') l.source = byId.get(String(l.source));
      if (typeof l.target !== 'object') l.target = byId.get(String(l.target));
    });
    this.links = this.links.filter((l) => l.source && l.target && l.source !== l.target);
  }

  setData(nodes, links, alpha = 1) {
    const first = this.nodes.length === 0;
    this.nodes = nodes || [];
    this.nodeMap = new Map(this.nodes.map((n) => [String(n._nid), n]));
    this.links = links || [];
    this._resolveLinkRefs();
    this._computeRadius();
    this.nodes.forEach((n) => {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.z)) this._seedPosition(n);
    });
    this.alpha = Math.max(this.alpha, first ? 1 : Math.min(1, alpha || 0.6));
  }

  addNodes(newNodes, links) {
    if (!newNodes || !newNodes.length) return;
    newNodes.forEach((n) => {
      if (n._nid && !this.nodeMap.has(String(n._nid))) {
        this.nodeMap.set(String(n._nid), n);
        this.nodes.push(n);
      }
    });
    this.links = links || this.links;
    this._computeRadius();
    this.nodes.forEach((n) => {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.z)) this._seedPosition(n);
    });
    this.alpha = Math.max(this.alpha, 0.5);
  }

  // 点亮节点：按传入顺序逐个延迟点亮（先召回的先亮），保持明亮后缓慢恢复
  highlight(nids, duration = 2400) {
    const now = Date.now();
    const step = Math.min(200, Math.max(90, Math.floor(duration / Math.max(1, nids.length))));
    nids.forEach((nid, i) => {
      this.active.set(String(nid), { start: now, delay: i * step, duration });
    });
  }

  // 点亮强度：0=熄灭 1=最亮。快速点亮(≈250ms) → 保持明亮 → 二次缓出缓慢恢复
  _highlightIntensity(state, now) {
    if (!state) return 0;
    const t = now - (state.start + state.delay);
    const dur = state.duration;
    if (t < 0 || t >= dur) return 0;
    const ramp = Math.min(260, dur * 0.25);
    if (t < ramp) return t / ramp;
    const holdEnd = dur * 0.45;
    if (t < holdEnd) return 1;
    const decay = (t - holdEnd) / Math.max(1, dur - holdEnd);
    return Math.max(0, 1 - decay * decay);
  }

  nudge(nodes) {
    if (!nodes || !nodes.length) return;
    const R = this.radius;
    nodes.forEach((nd) => {
      if (nd.fx != null) return;
      const a = Math.random() * Math.PI * 2;
      nd.vx += Math.cos(a) * R * 0.012;
      nd.vy += Math.sin(a) * R * 0.012;
      nd.vz += (Math.random() - 0.5) * R * 0.015;
    });
    this.alpha = Math.max(this.alpha, 0.28);
  }

  nudgeAll() {
    if (!this.nodes.length) return;
    this.nodes.forEach((nd) => {
      if (nd.fx == null && !nd._core) {
        nd.vx += (Math.random() - 0.5) * 0.4;
        nd.vy += (Math.random() - 0.5) * 0.4;
        nd.vz += (Math.random() - 0.5) * 0.4;
      }
    });
    this.alpha = Math.max(this.alpha, 0.3);
  }

  setPhysics(params) {
    if (!params) return;
    this.params.gravity = Number(params.gravity) || 1;
    this.params.repulsion = Number(params.repulsion) || 1;
    this.params.nodeSize = Number(params.nodeSize) || 1;
  }

  refreshVisuals() {
    // 2D 渲染逐帧读取颜色，无需缓存
  }

  resetView() {
    this.camDist = Math.max(this.radius * 4.6, 240);
    this.rotX = 0;
    this.rotY = 0;
    this.autoRotate = true;
    this.nodes.forEach((n) => this._seedPosition(n));
    this.alpha = Math.max(this.alpha, 1);
  }

  // ── 力学 ────────────────────────────────────────────────

  _stepPhysics() {
    const nodes = this.nodes, links = this.links, n = nodes.length;
    if (!n) return;
    const R = this.radius, alpha = this.alpha, p = this.physics, grav = this.params.gravity;

    const shellK = p.shellK * (0.5 + 0.5 * alpha) * (0.8 + 0.4 * grav);
    const targetFactor = Math.max(0.5, 1.0 - 0.1 * grav);
    for (const nd of nodes) {
      if (nd.fx != null) continue;
      let d = Math.hypot(nd.x, nd.y, nd.z);
      if (d < 1e-4) { nd.x = R; nd.y = 0; nd.z = 0; d = R; }
      // 柔和壳层带（与 3D 一致）
      const target = R * targetFactor * (0.82 + 0.3 * (0.5 + 0.5 * Math.sin(idHash(nd._nid) * 37)));
      const shell = (target - d) * shellK;
      nd.vx += (nd.x / d) * shell; nd.vy += (nd.y / d) * shell; nd.vz += (nd.z / d) * shell;
    }

    const linkK = p.linkK * (0.3 + 0.7 * alpha);
    for (const l of links) {
      const s = l.source, t = l.target;
      if (s.fx != null && t.fx != null) continue;
      let dx = t.x - s.x, dy = t.y - s.y, dz = t.z - s.z;
      let len = Math.hypot(dx, dy, dz);
      if (len < 1e-4) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = Math.random() - 0.5; len = Math.hypot(dx, dy, dz) || 1; }
      const rest = this._linkRest(l);
      const f = (len - rest) * linkK;
      const fx = (dx / len) * f, fy = (dy / len) * f, fz = (dz / len) * f;
      if (s.fx == null) { s.vx += fx; s.vy += fy; s.vz += fz; }
      if (t.fx == null) { t.vx -= fx; t.vy -= fy; t.vz -= fz; }
    }

    if (alpha > 0.03 && n <= 1000) {
      const repK = p.repK * this.params.repulsion * (0.25 + 0.75 * alpha);
      const minDist = p.minDist * (0.6 + 0.2 * this.params.repulsion);
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        if (a.fx != null) continue;
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          if (b.fx != null) continue;
          const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 1e-6 || d2 > minDist * minDist * 8) continue;
          const dist = Math.sqrt(d2);
          const force = repK / Math.max(d2, 0.6);
          const fx = (dx / dist) * force, fy = (dy / dist) * force, fz = (dz / dist) * force;
          a.vx -= fx; a.vy -= fy; a.vz -= fz;
          b.vx += fx; b.vy += fy; b.vz += fz;
          if (dist < minDist) {
            const push = (minDist - dist) * 0.45 * alpha;
            a.x -= (dx / dist) * push; a.y -= (dy / dist) * push; a.z -= (dz / dist) * push;
            b.x += (dx / dist) * push; b.y += (dy / dist) * push; b.z += (dz / dist) * push;
          }
        }
      }
    }

    for (const nd of nodes) {
      if (nd.fx != null) continue;
      nd.vx *= p.damp; nd.vy *= p.damp; nd.vz *= p.damp;
      const sp = Math.hypot(nd.vx, nd.vy, nd.vz);
      if (sp > 5) { const s = 5 / sp; nd.vx *= s; nd.vy *= s; nd.vz *= s; }
      nd.x += nd.vx; nd.y += nd.vy; nd.z += nd.vz;
    }

    this.alpha *= 0.985;
    if (this.alpha < 0.02) this.alpha = 0;
  }

  // ── 投影 / 命中 ─────────────────────────────────────────

  _project(node) {
    // 绕 Y 轴再绕 X 轴旋转
    const cosY = Math.cos(this.rotY), sinY = Math.sin(this.rotY);
    const x1 = node.x * cosY + node.z * sinY;
    const z1 = -node.x * sinY + node.z * cosY;
    const cosX = Math.cos(this.rotX), sinX = Math.sin(this.rotX);
    const y1 = node.y * cosX - z1 * sinX;
    const z2 = node.y * sinX + z1 * cosX;

    const viewZ = this.camDist - z2;
    if (viewZ < 0.1) return null;
    const focal = (this._H / 2) / Math.tan((45 * Math.PI) / 360);
    const k = focal / viewZ;
    return {
      x: this._W / 2 + x1 * k,
      y: this._H / 2 - y1 * k,
      z: z2,
      viewZ,
      depth: Math.max(0, Math.min(1, (viewZ - this.camDist + this.radius) / (2 * this.radius))),
      k,
    };
  }

  _pickNode(px, py) {
    const dpr = this._dpr;
    const rect = this.canvas.getBoundingClientRect();
    const sx = (px - rect.left) * dpr;
    const sy = (py - rect.top) * dpr;
    let best = null, bestDist = Infinity;
    this.nodes.forEach((nd) => {
      const pr = this._project(nd);
      if (!pr) return;
      const hitR = Math.max(10, (this.opts.getNodeRadius ? this.opts.getNodeRadius(nd) : 4) * 2.2 * pr.k * this.params.nodeSize);
      const d = Math.hypot(pr.x - sx, pr.y - sy);
      if (d < hitR && d < bestDist) { bestDist = d; best = nd; }
    });
    return best;
  }

  _hoverAt(px, py) {
    const hit = this._pickNode(px, py);
    if (hit === this.hoverNode) return;
    this.hoverNode = hit;
    this.canvas.style.cursor = hit ? 'pointer' : 'grab';
    if (this.opts.onHover) this.opts.onHover(hit, px, py);
  }

  _dragNodeTo(px, py) {
    const nd = this.dragNode;
    if (!nd) return;
    // 直接按当前视角把指针位置反投影到球面（简化：固定到离相机最近的球面上一点）
    const R = this.radius;
    const dpr = this._dpr;
    const rect = this.canvas.getBoundingClientRect();
    const focal = (this._H / 2) / Math.tan((45 * Math.PI) / 360);
    const invK = 1 / (focal / (this.camDist - R)); // 近似：球面正面到相机的平均距离
    const xw = ((px - rect.left) * dpr - this._W / 2) * invK;
    const yw = -((py - rect.top) * dpr - this._H / 2) * invK;
    // 反旋转（先 X 再 Y）
    const cosX = Math.cos(-this.rotX), sinX = Math.sin(-this.rotX);
    const y1 = yw * cosX;
    const z1r = yw * sinX;
    const cosY = Math.cos(-this.rotY), sinY = Math.sin(-this.rotY);
    const xw2 = xw * cosY + z1r * sinY;
    const zw2 = -xw * sinY + z1r * cosY;
    const len = Math.hypot(xw2, y1, zw2) || 1;
    nd.fx = (xw2 / len) * R; nd.fy = (y1 / len) * R; nd.fz = (zw2 / len) * R;
    nd.x = nd.fx; nd.y = nd.fy; nd.z = nd.fz;
  }

  // ── 每帧绘制 ───────────────────────────────────────────

  _draw() {
    const ctx = this.ctx;
    const W = this._W, H = this._H;
    const now = Date.now();
    ctx.clearRect(0, 0, W, H);

    // 星空
    const theme = this.opts.getTheme ? this.opts.getTheme() : {};
    ctx.save();
    this.stars.forEach((s) => {
      ctx.globalAlpha = s.a;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();

    // 大气辉光
    const R = this.radius;
    const focal = (H / 2) / Math.tan((45 * Math.PI) / 360);
    const shellK = focal / this.camDist;
    const atmoR = R * 1.2 * shellK;
    const cx = W / 2, cy = H / 2;
    const coolCss = theme.cool || '#4f8cff';
    const cool = this._hex(coolCss);
    const atmoGrad = ctx.createRadialGradient(cx, cy, atmoR * 0.55, cx, cy, atmoR);
    atmoGrad.addColorStop(0, 'rgba(' + cool.r + ',' + cool.g + ',' + cool.b + ',0.05)');
    atmoGrad.addColorStop(1, 'rgba(' + cool.r + ',' + cool.g + ',' + cool.b + ',0)');
    ctx.fillStyle = atmoGrad;
    ctx.fillRect(cx - atmoR * 1.4, cy - atmoR * 1.4, atmoR * 2.8, atmoR * 2.8);

    // 线框球壳：投影三条大圆
    ctx.save();
    ctx.strokeStyle = 'rgba(' + cool.r + ',' + cool.g + ',' + cool.b + ',0.14)';
    ctx.lineWidth = 1;
    this._drawGreatCircle(ctx, 0.7, 48);   // 横纬圈
    this._drawGreatCircle(ctx, 0.45, 48);  // 纬线
    this._drawMeridian(ctx, 0, 48);        // 经线 1
    this._drawMeridian(ctx, Math.PI / 2, 48); // 经线 2
    ctx.restore();

    // 连线（先画，节点盖上面）
    const linkCol = { r: 143, g: 182, b: 216 };
    ctx.save();
    ctx.lineWidth = 1;
    for (const l of this.links) {
      const sp = this._project(l.source), tp = this._project(l.target);
      if (!sp || !tp) continue;
      const a = (l._kind === 'visual_parent' ? 0.32 : l._kind === 'visual_random' ? 0.12 : 0.24);
      ctx.strokeStyle = 'rgba(' + linkCol.r + ',' + linkCol.g + ',' + linkCol.b + ',' + a + ')';
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y);
      ctx.lineTo(tp.x, tp.y);
      ctx.stroke();
    }
    ctx.restore();

    // 节点（画家算法：远→近）
    const projs = [];
    this.nodes.forEach((nd) => {
      const pr = this._project(nd);
      if (pr) projs.push({ nd, pr });
    });
    projs.sort((a, b) => b.pr.depth - a.pr.depth); // 远(0)→近(1)，先画远的

    projs.forEach(({ nd, pr }) => {
      const base = this.opts.getNodeRadius ? this.opts.getNodeRadius(nd) : 3.5;
      let scale = base * 2.1 * this.params.nodeSize * (0.6 + 0.5 * pr.depth);
      const nid = String(nd._nid);
      const state = this.active.get(nid);
      const intensity = this._highlightIntensity(state, now);
      if (state && intensity <= 0) this.active.delete(nid);

      if (this.hoverNode === nd) scale *= 1.18;
      if (intensity > 0) scale *= 1 + 0.32 * intensity;
      const rr = Math.max(2, scale * pr.k * 0.5);
      const opacity = (0.34 + 0.66 * pr.depth) + 0.05 * intensity;

      const css = this.opts.getNodeColor ? this.opts.getNodeColor(nd) : '#8b95a5';
      const c = this._hex(css);

      // 被使用时：先画一层加法光晕（点亮），强度随点亮曲线走
      if (intensity > 0) {
        const g = ctx.createRadialGradient(pr.x, pr.y, 0, pr.x, pr.y, rr * (2.4 + 1.0 * intensity));
        g.addColorStop(0, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + (0.75 * intensity * (0.5 + 0.5 * pr.depth)) + ')');
        g.addColorStop(1, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, rr * (2.4 + 1.0 * intensity), 0, Math.PI * 2);
        ctx.fill();
      }

      // 平色圆点（与图例一致，不发光）
      ctx.globalAlpha = Math.max(0.12, 0.95 * opacity);
      ctx.fillStyle = 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    });
  }

  _hex(css) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(css || '').trim());
    if (!m) return { r: 79, g: 140, b: 255 };
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  _drawGreatCircle(ctx, ry, segs) {
    // 绕 Y 轴纬圈（相对半径 ry 的圈），采样后投影成折线
    const R = this.radius;
    ctx.beginPath();
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const p = { x: Math.cos(a) * R, y: Math.sin(a) * R * ry, z: 0 };
      const pr = this._project(p);
      if (pr) i === 0 ? ctx.moveTo(pr.x, pr.y) : ctx.lineTo(pr.x, pr.y);
    }
    ctx.stroke();
  }

  _drawMeridian(ctx, phase, segs) {
    const R = this.radius;
    ctx.beginPath();
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const p = { x: Math.cos(a) * Math.cos(phase) * R, y: Math.sin(a) * R, z: Math.cos(a) * Math.sin(phase) * R };
      const pr = this._project(p);
      if (pr) i === 0 ? ctx.moveTo(pr.x, pr.y) : ctx.lineTo(pr.x, pr.y);
    }
    ctx.stroke();
  }

  _checkResize() {
    const c = this.canvas;
    const rect = c.getBoundingClientRect();
    const w = rect.width || c.clientWidth;
    const h = rect.height || c.clientHeight;
    if (!w || !h) return;
    const dpr = this._dpr || Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(w * dpr);
    const H = Math.round(h * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
      this._W = w;
      this._H = h;
    }
  }

  _animate() {
    if (this._disposed) return;
    this.animFrame = requestAnimationFrame(() => this._animate());
    this._time += 1;
    this._checkResize();

    if (this.alpha > 0) this._stepPhysics();

    const now = performance.now();
    if (this.isOrbiting) this.autoRotate = false;
    else if (!this.dragNode && now - (this._lastInteract || 0) > 2400) this.autoRotate = true;
    if (this.autoRotate && !this.isOrbiting && !this.dragNode) {
      this.rotY += 0.0012 * (0.6 + 0.6 * this.params.gravity);
    }

    this._draw();
  }

  pause() {
    if (this.animFrame) { cancelAnimationFrame(this.animFrame); this.animFrame = null; }
  }

  resume() {
    if (!this.animFrame && !this._disposed) this._animate();
  }

  dispose() {
    this._disposed = true;
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    const c = this.canvas, b = this._bound;
    if (b.onDown) c.removeEventListener('pointerdown', b.onDown);
    if (b.onMove) c.removeEventListener('pointermove', b.onMove);
    if (b.onUp) { c.removeEventListener('pointerup', b.onUp); c.removeEventListener('pointercancel', b.onUp); }
    if (b.onWheel) c.removeEventListener('wheel', b.onWheel);
  }
}
