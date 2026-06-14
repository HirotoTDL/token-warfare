# 商業レベル構造物ビルダー(headless) — 旋盤回転体(Screw)による繰形・フルート彫り・装飾リング・
# サブサーフ・ヴーソワール等で本格的に作り込む。kind引数で種別切替。既存/発注GPTテクスチャをBOX投影。
import bpy, math, mathutils, sys, os
a = sys.argv[sys.argv.index("--") + 1:]
kind, out, render = a[0], a[1], a[2]
ART = os.path.abspath("public/art")
bpy.ops.wm.read_factory_settings(use_empty=True)
OBJS = []


def tex_mat(name, tex, scale=2.0, rough=0.5, metal=0.0, emit=None, ecol=(1, 1, 1), emit_from_tex=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree
    b = nt.nodes["Principled BSDF"]; b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if tex:
        img = bpy.data.images.load(os.path.join(ART, tex), check_existing=True)
        tc = nt.nodes.new("ShaderNodeTexCoord"); mp = nt.nodes.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (scale, scale, scale)
        ti = nt.nodes.new("ShaderNodeTexImage"); ti.image = img; ti.projection = 'BOX'; ti.extension = 'REPEAT'
        nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"]); nt.links.new(mp.outputs["Vector"], ti.inputs["Vector"])
        nt.links.new(ti.outputs["Color"], b.inputs["Base Color"])
        if emit_from_tex > 0:
            nt.links.new(ti.outputs["Color"], b.inputs["Emission Color"]); b.inputs["Emission Strength"].default_value = emit_from_tex
    if emit is not None:
        b.inputs["Emission Color"].default_value = (*ecol, 1); b.inputs["Emission Strength"].default_value = emit
    return m


def solid_mat(name, rgb, rough=0.45, metal=0.0, emit=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if emit > 0:
        b.inputs["Emission Color"].default_value = (*rgb, 1); b.inputs["Emission Strength"].default_value = emit
    return m


def shade_smooth(o):
    for f in o.data.polygons:
        f.use_smooth = True


def revolve(profile, mat, segs=64, name="rev", smooth_lv=1):
    """(x,z)プロファイルをZ軸回転→回転体。繰形のある旋盤造形に使う。"""
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x, 0.0, z) for (x, z) in profile], [(i, i + 1) for i in range(len(profile) - 1)], [])
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o
    sc = o.modifiers.new("screw", 'SCREW'); sc.axis = 'Z'; sc.angle = math.radians(360); sc.steps = segs; sc.use_merge_vertices = True; sc.use_normal_calculate = True
    bpy.ops.object.modifier_apply(modifier="screw")
    shade_smooth(o)
    if smooth_lv:
        s = o.modifiers.new("ss", 'SUBSURF'); s.levels = smooth_lv; bpy.ops.object.modifier_apply(modifier="ss")
    if mat:
        o.data.materials.append(mat)
    OBJS.append(o); return o


def add(prim, mat, smooth=True, **kw):
    getattr(bpy.ops.mesh, prim)(**kw); o = bpy.context.object
    if smooth:
        shade_smooth(o)
    if mat:
        o.data.materials.append(mat)
    OBJS.append(o); return o


def bevel(o, w=0.02, seg=2):
    bpy.context.view_layer.objects.active = o
    mod = o.modifiers.new("b", 'BEVEL'); mod.width = w; mod.segments = seg; mod.limit_method = 'ANGLE'
    bpy.ops.object.modifier_apply(modifier="b")


def boolean_diff(target, cutter):
    bpy.context.view_layer.objects.active = target
    bm = target.modifiers.new("bool", 'BOOLEAN'); bm.operation = 'DIFFERENCE'; bm.object = cutter; bm.solver = 'EXACT'
    bpy.ops.object.modifier_apply(modifier="bool")
    bpy.data.objects.remove(cutter, do_unlink=True)


def join_temp(objs):
    """OBJSに入れず一時メッシュを結合(カッター用)。"""
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    return objs[0]


def flute_shaft(shaft, n, ring_r, z0, z1, cut_r=0.045):
    """シャフトに縦溝(フルート)をブーリアンで彫る。"""
    cz = (z0 + z1) / 2; depth = (z1 - z0)
    cutters = []
    for k in range(n):
        ang = k / n * math.tau
        bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=cut_r, depth=depth, location=(ring_r * math.cos(ang), ring_r * math.sin(ang), cz))
        cutters.append(bpy.context.object)
    boolean_diff(shaft, join_temp(cutters))


def egg_dart_ring(z, r, mat, n=16, scale=0.075):
    for k in range(n):
        ang = k / n * math.tau
        if k % 2 == 0:
            bpy.ops.mesh.primitive_uv_sphere_add(radius=scale, location=(r * math.cos(ang), r * math.sin(ang), z))
            o = bpy.context.object; o.scale = (1, 1, 1.4)
        else:
            bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=scale * 0.55, radius2=0, depth=scale * 2.2, location=(r * math.cos(ang), r * math.sin(ang), z - scale * 0.2))
        shade_smooth(o := bpy.context.object); o.data.materials.append(mat); OBJS.append(o)


def ring_of(prim, n, ring_r, z, mat, rot_face=True, **kw):
    for k in range(n):
        ang = k / n * math.tau
        getattr(bpy.ops.mesh, prim)(location=(ring_r * math.cos(ang), ring_r * math.sin(ang), z), **kw)
        o = bpy.context.object
        if rot_face:
            o.rotation_euler = (0, 0, ang)
        shade_smooth(o); o.data.materials.append(mat); OBJS.append(o)


# ===== マテリアル =====
MARBLE = tex_mat("marble", "tex_pearl_marble_floor.png", 2.2, 0.3)
STONE = tex_mat("stone", "tex_magic_stone_blocks.png", 1.8, 0.65)
GOLD = solid_mat("gold", (0.96, 0.80, 0.40), 0.22, 1.0)
CRYST = solid_mat("crystal", (0.65, 0.93, 0.97), 0.08, 0.0, emit=1.8)
GATESTONE = tex_mat("gatestone", "tex_carved_fairy_gate.png", 1.3, 0.6)
OBELISKSTONE = tex_mat("obeliskstone", "tex_rune_obelisk.png", 1.0, 0.45, emit_from_tex=1.4)
BRONZE = tex_mat("bronze", "tex_ornate_bronze.png", 1.0, 0.35, metal=0.85)
ROOFTILE = tex_mat("roof", "tex_pastel_tile_wall.png", 2.5, 0.5)

# 古典柱のプロファイル(台座→ベース繰形→エンタシス軸→ネッキング→エキヌス→アバクス)
COL_PROFILE = [
    (0.00, 0.00), (0.74, 0.00), (0.74, 0.12), (0.62, 0.16),
    (0.68, 0.22), (0.60, 0.27), (0.54, 0.31), (0.56, 0.35), (0.50, 0.40),
    (0.515, 1.30), (0.50, 2.4), (0.455, 3.45),
    (0.43, 3.58), (0.475, 3.66), (0.43, 3.74),
    (0.46, 3.80), (0.60, 4.06), (0.70, 4.16),
    (0.78, 4.20), (0.78, 4.40), (0.66, 4.44), (0.00, 4.46),
]


def make_column(matshaft, base_z=0.0, with_capital=True):
    """旋盤+フルート+柱頭装飾の本格柱を base_z から積む。戻り値=柱本体"""
    prof = [(x, z + base_z) for (x, z) in COL_PROFILE]
    col = revolve(prof, matshaft, 72, "column", 2)
    flute_shaft(col, 24, 0.50, base_z + 0.42, base_z + 3.45)
    if with_capital:
        egg_dart_ring(base_z + 3.92, 0.60, GOLD, 16, 0.07)
        add('primitive_torus_add', GOLD, major_radius=0.50, minor_radius=0.035, location=(0, 0, base_z + 3.70), major_segments=48, minor_segments=12)
    return col


def build_pillar():
    make_column(MARBLE, 0.0, True)
    add('primitive_ico_sphere_add', CRYST, radius=0.18, location=(0, 0, 4.62), subdivisions=2)


def build_gate():
    # 2本の本格柱(短め)+ ヴーソワール(楔石)のアーチ + キーストーン + 頂部装飾
    for sx in (-1, 1):
        prof = [(x, z * 0.78) for (x, z) in COL_PROFILE]  # 少し低い柱
        col = revolve([(p[0], p[1]) for p in prof], GATESTONE, 64, "gcol", 2)
        col.location.x = sx * 3.0
        flute_shaft_world = None  # 柱位置移動後はフルート省略(負荷軽減)
    # アーチ: 楔石(ボックス)を半円に放射配置
    R = 3.0; cz = 4.0; n = 13
    for k in range(n):
        t = k / (n - 1)
        ang = math.pi * t  # 0..π
        x = R * math.cos(ang); z = cz + R * math.sin(ang)
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x, 0, z))
        o = bpy.context.object; o.scale = (0.36, 0.62, 0.62); o.rotation_euler = (0, -ang + math.pi / 2, 0)
        o.data.materials.append(GATESTONE); bevel(o, 0.03, 2); OBJS.append(o)
    # キーストーン(頂点で大きく)
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, cz + R + 0.15)); ks = bpy.context.object
    ks.scale = (0.32, 0.7, 0.5); ks.data.materials.append(GOLD); bevel(ks, 0.03, 2); OBJS.append(ks)
    # 内周/外周の金トリム(アーチを縁取り)
    for rr, mr in [(R - 0.32, 0.05), (R + 0.34, 0.05)]:
        g = add('primitive_torus_add', GOLD, major_radius=rr, minor_radius=mr, location=(0, 0, cz), major_segments=48, minor_segments=10)
        g.rotation_euler = (math.radians(90), 0, 0)
        bpy.context.view_layer.objects.active = g
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='DESELECT'); bpy.ops.object.mode_set(mode='OBJECT')
        for v in g.data.vertices:
            if (g.matrix_world @ v.co).z < cz - 0.01:
                v.select = True
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.delete(type='VERT'); bpy.ops.object.mode_set(mode='OBJECT')
    add('primitive_ico_sphere_add', CRYST, radius=0.32, location=(0, 0, cz + R + 0.7), subdivisions=2)


def build_obelisk():
    # 段つき台座(繰形)+ 4面テーパー軸(ルーン)+ ピラミディオン + 金縁 + 頂部クリスタル
    base_prof = [(0.0, 0.0), (1.15, 0.0), (1.15, 0.32), (0.95, 0.40), (1.0, 0.5), (0.78, 0.62), (0.66, 0.7), (0.0, 0.7)]
    revolve(base_prof, STONE, 4, "obase", 0)  # 4セグ=四角錐台の段台座
    # 軸(4角テーパー)
    add('primitive_cone_add', OBELISKSTONE, vertices=4, radius1=0.6, radius2=0.30, depth=5.2, location=(0, 0, 3.3), rotation=(0, 0, math.radians(45)), smooth=False)
    # 各面の縦エッジに金トリム
    for k in range(4):
        ang = k / 4 * math.tau + math.radians(45)
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.43 * math.cos(ang), 0.43 * math.sin(ang), 3.3))
        o = bpy.context.object; o.scale = (0.04, 0.04, 2.6); o.rotation_euler = (0, 0, ang); o.data.materials.append(GOLD); OBJS.append(o)
    # ピラミディオン(頂部の角錐)+金
    add('primitive_cone_add', GOLD, vertices=4, radius1=0.32, radius2=0, depth=0.8, location=(0, 0, 6.3), rotation=(0, 0, math.radians(45)), smooth=False)
    add('primitive_ico_sphere_add', CRYST, radius=0.24, location=(0, 0, 6.4), subdivisions=2)


def build_brazier():
    FLAME = solid_mat("flame", (1.0, 0.42, 0.12), 0.4, 0.0, emit=3.2)
    FLAMEW = solid_mat("flamew", (1.0, 0.78, 0.4), 0.4, 0.0, emit=2.4)
    # 旋盤造形の脚付き聖火台(フット→バルスター柄→オジー曲線のボウル)
    prof = [
        (0.0, 0.0), (0.62, 0.0), (0.62, 0.12), (0.42, 0.2),     # フット
        (0.3, 0.32), (0.22, 0.55), (0.3, 0.85),                  # バルスター柄
        (0.26, 0.95), (0.34, 1.05),                              # ノット
        (0.30, 1.15), (0.52, 1.5), (0.7, 1.85), (0.72, 1.95),    # オジー曲線のボウル
        (0.62, 1.98), (0.0, 1.6),                                # ボウル内側(凹み)
    ]
    revolve(prof, BRONZE, 48, "brazier", 2)
    add('primitive_torus_add', GOLD, major_radius=0.72, minor_radius=0.06, location=(0, 0, 1.95), major_segments=32, minor_segments=10)
    # 3本の装飾脚
    for k in range(3):
        ang = k / 3 * math.tau
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.5 * math.cos(ang), 0.5 * math.sin(ang), 0.5))
        o = bpy.context.object; o.scale = (0.06, 0.06, 0.55); o.rotation_euler = (math.radians(12), 0, ang); o.data.materials.append(GOLD); OBJS.append(o)
    # 炎(複数コーンで揺らぎ感。外側=濃いオレンジ/内側=明るい黄)+ 発光コア
    for (rr, dz, sc, fm) in [(0, 0, 1.0, FLAME), (0.18, 0.05, 0.6, FLAME), (-0.16, -0.03, 0.55, FLAME), (0, 0.02, 0.5, FLAMEW)]:
        add('primitive_cone_add', fm, vertices=10, radius1=0.34 * sc, radius2=0, depth=1.2 * sc, location=(rr, dz, 2.1 + 0.5 * sc), smooth=True)
    add('primitive_uv_sphere_add', FLAMEW, radius=0.2, location=(0, 0, 2.0))


def build_canopy():
    # リブ付きドーム屋根(旋盤ドーム+放射リブ+頂部フィニアル+吊り下げクリスタル)
    dome_prof = [(0.0, 2.6), (1.1, 2.5), (2.2, 2.1), (3.2, 1.3), (3.9, 0.5), (4.4, 0.1), (4.5, -0.1), (4.5, -0.35)]
    revolve(dome_prof, ROOFTILE, 48, "dome", 1)
    # 軒の金リング
    add('primitive_torus_add', GOLD, major_radius=4.5, minor_radius=0.12, location=(0, 0, -0.2), major_segments=48, minor_segments=12)
    # 放射状のリブ(8本)
    for k in range(8):
        ang = k / 8 * math.tau
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=(2.2 * math.cos(ang), 2.2 * math.sin(ang), 1.6))
        o = bpy.context.object; o.scale = (0.08, 0.08, 0.08)
        # リブはカーブに沿わせるのは複雑なので、軒〜頂部を結ぶ細い角材で近似
        o.dimensions = (0.1, 4.6, 0.18); o.rotation_euler = (math.radians(58), 0, ang + math.pi / 2)
        o.data.materials.append(GOLD); OBJS.append(o)
    # 頂部フィニアル(旋盤)+クリスタル
    fin_prof = [(0.0, 2.5), (0.35, 2.55), (0.2, 2.8), (0.42, 3.0), (0.12, 3.4), (0.0, 3.7)]
    revolve(fin_prof, GOLD, 32, "finial", 1)
    add('primitive_ico_sphere_add', CRYST, radius=0.3, location=(0, 0, 3.9), subdivisions=2)
    # 軒に吊り下げる小クリスタル
    for k in range(8):
        ang = k / 8 * math.tau
        add('primitive_ico_sphere_add', CRYST, radius=0.16, location=(4.3 * math.cos(ang), 4.3 * math.sin(ang), -0.45), subdivisions=2)


BUILDERS = {'pillar': build_pillar, 'gate': build_gate, 'obelisk': build_obelisk, 'brazier': build_brazier, 'canopy': build_canopy}
BUILDERS[kind]()

bpy.ops.object.select_all(action='DESELECT')
for o in OBJS:
    o.select_set(True)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_yup=True)
print("EXPORT", out)

# ---- レンダ ----
mn = mathutils.Vector((1e9,) * 3); mx = mathutils.Vector((-1e9,) * 3)
for o in OBJS:
    for c in o.bound_box:
        w = o.matrix_world @ mathutils.Vector(c)
        for i in range(3):
            mn[i] = min(mn[i], w[i]); mx[i] = max(mx[i], w[i])
ctr = (mn + mx) / 2; H = max(mx.z - mn.z, mx.x - mn.x)
bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, mn.z))
bpy.context.object.data.materials.append(tex_mat("g", "tex_pearl_marble_floor.png", 5, 0.6))
cam_d = bpy.data.cameras.new("C"); cam = bpy.data.objects.new("C", cam_d); bpy.context.scene.collection.objects.link(cam)
cam.location = (H * 0.6, -H * 1.5, ctr.z + H * 0.28)
look = mathutils.Vector(ctr) - mathutils.Vector(cam.location); cam.rotation_euler = look.to_track_quat('-Z', 'Y').to_euler(); bpy.context.scene.camera = cam
ld = bpy.data.lights.new("L", 'SUN'); lo = bpy.data.objects.new("L", ld); bpy.context.scene.collection.objects.link(lo); ld.energy = 2.8; lo.rotation_euler = (math.radians(48), math.radians(12), math.radians(32))
fd = bpy.data.lights.new("F", 'AREA'); fo = bpy.data.objects.new("F", fd); bpy.context.scene.collection.objects.link(fo); fd.energy = 400; fo.location = (-H * 0.6, -H * 0.6, H * 0.8)
w = bpy.data.worlds.new("W"); w.use_nodes = True; w.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.62, 0.78, 1); bpy.context.scene.world = w
sc = bpy.context.scene; sc.render.engine = 'BLENDER_EEVEE_NEXT'; sc.render.resolution_x = 480; sc.render.resolution_y = 600; sc.render.filepath = render
sc.view_settings.view_transform = 'AgX'; sc.view_settings.exposure = -0.1
bpy.ops.render.render(write_still=True); print("RENDER", render)
