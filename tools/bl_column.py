# 本格的な装飾柱(商業レベル)。断面プロファイルの回転体(Screw)で繰形を作り、
# フルート(縦溝)をブーリアンで彫り、柱頭装飾(エッグ&ダート)を加え、サブサーフで滑らかにする。
import bpy, math, mathutils, sys, os
a = sys.argv[sys.argv.index("--") + 1:]
out, render = a[0], a[1]
ART = os.path.abspath("public/art")
bpy.ops.wm.read_factory_settings(use_empty=True)


def tex_mat(name, tex, scale=2.0, rough=0.4, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree
    b = nt.nodes["Principled BSDF"]; b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if tex:
        img = bpy.data.images.load(os.path.join(ART, tex), check_existing=True)
        tc = nt.nodes.new("ShaderNodeTexCoord"); mp = nt.nodes.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (scale, scale, scale)
        ti = nt.nodes.new("ShaderNodeTexImage"); ti.image = img; ti.projection = 'BOX'; ti.extension = 'REPEAT'
        nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"]); nt.links.new(mp.outputs["Vector"], ti.inputs["Vector"])
        nt.links.new(ti.outputs["Color"], b.inputs["Base Color"])
    return m


def solid_mat(name, rgb, rough=0.4, metal=0.0, emit=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if emit > 0:
        b.inputs["Emission Color"].default_value = (*rgb, 1); b.inputs["Emission Strength"].default_value = emit
    return m


MARBLE = tex_mat("marble", "tex_pearl_marble_floor.png", 2.2, 0.3)
GOLD = solid_mat("gold", (0.96, 0.80, 0.40), 0.22, 1.0)
CRYST = solid_mat("crystal", (0.65, 0.93, 0.97), 0.08, 0.0, emit=1.8)


def revolve(profile, segs=64, name="rev"):
    """(x,z)プロファイルポリラインをZ軸回転して回転体メッシュを作る"""
    me = bpy.data.meshes.new(name)
    verts = [(x, 0.0, z) for (x, z) in profile]
    edges = [(i, i + 1) for i in range(len(profile) - 1)]
    me.from_pydata(verts, edges, [])
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    bpy.context.view_layer.objects.active = o
    sc = o.modifiers.new("screw", 'SCREW'); sc.axis = 'Z'; sc.angle = math.radians(360); sc.steps = segs; sc.render_steps = segs
    sc.use_merge_vertices = True; sc.use_normal_calculate = True
    bpy.ops.object.modifier_apply(modifier="screw")
    return o


def smooth(o, levels=2):
    bpy.context.view_layer.objects.active = o
    for f in o.data.polygons:
        f.use_smooth = True
    s = o.modifiers.new("subsurf", 'SUBSURF'); s.levels = levels; s.render_levels = levels
    bpy.ops.object.modifier_apply(modifier="subsurf")


# ---- 柱本体: 断面プロファイル(台座→繰形ベース→エンタシス軸→ネッキング→エキヌス→アバクス) ----
profile = [
    (0.00, 0.00), (0.74, 0.00), (0.74, 0.12), (0.62, 0.16),       # 台座ブロック+面取り
    (0.68, 0.22), (0.60, 0.27), (0.54, 0.31), (0.56, 0.35),        # トーラス+スコチア+フィレット(ベース繰形)
    (0.50, 0.40),                                                  # 軸の付け根
    (0.515, 1.30), (0.50, 2.4), (0.455, 3.45),                     # エンタシス(微膨らみ)→上細り
    (0.43, 3.58), (0.475, 3.66), (0.43, 3.74),                     # ネッキング+アストラガル(ビード)
    (0.46, 3.80), (0.60, 4.06), (0.70, 4.16),                      # エキヌス(オボロ曲線)
    (0.78, 4.20), (0.78, 4.40), (0.66, 4.44),                      # アバクス(冠板)
    (0.00, 4.46),                                                  # 天頂閉じ
]
col = revolve(profile, 72, "column")
smooth(col, 2)
col.data.materials.append(MARBLE)

# ---- フルート(縦溝): 24本の細い円柱をシャフト周囲に並べブーリアン減算 ----
cutters = []
NF = 24
for k in range(NF):
    ang = k / NF * math.tau
    bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.045, depth=3.6, location=(0.50 * math.cos(ang), 0.50 * math.sin(ang), 1.9))
    cutters.append(bpy.context.object)
# 統合して1回のブーリアン
bpy.context.view_layer.objects.active = cutters[0]
for c in cutters[1:]:
    c.select_set(True)
cutters[0].select_set(True)
bpy.ops.object.join()
cutter = cutters[0]
bpy.context.view_layer.objects.active = col
bm = col.modifiers.new("flute", 'BOOLEAN'); bm.operation = 'DIFFERENCE'; bm.object = cutter; bm.solver = 'EXACT'
bpy.ops.object.modifier_apply(modifier="flute")
bpy.data.objects.remove(cutter, do_unlink=True)

OBJS = [col]
# ---- 柱頭の装飾: エッグ&ダート風リング(球と尖りを交互に) ----
for k in range(16):
    ang = k / 16 * math.tau
    r = 0.60
    if k % 2 == 0:
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.075, location=(r * math.cos(ang), r * math.sin(ang), 3.92))
        o = bpy.context.object; o.scale = (1, 1, 1.4); o.data.materials.append(GOLD)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=0.04, radius2=0, depth=0.16, location=(r * math.cos(ang), r * math.sin(ang), 3.9))
        o = bpy.context.object; o.data.materials.append(GOLD)
    for f in o.data.polygons:
        f.use_smooth = True
    OBJS.append(o)
# ベースの金リング(アストラガル強調)
bpy.ops.mesh.primitive_torus_add(major_radius=0.50, minor_radius=0.035, location=(0, 0, 3.70), major_segments=48, minor_segments=12)
OBJS.append(bpy.context.object); bpy.context.object.data.materials.append(GOLD)
# 頂部クリスタル
bpy.ops.mesh.primitive_ico_sphere_add(radius=0.18, location=(0, 0, 4.62), subdivisions=2)
OBJS.append(bpy.context.object); bpy.context.object.data.materials.append(CRYST)
for o in OBJS:
    for f in o.data.polygons:
        f.use_smooth = True

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
ctr = (mn + mx) / 2; H = mx.z - mn.z
bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, mn.z))
bpy.context.object.data.materials.append(tex_mat("g", "tex_pearl_marble_floor.png", 4, 0.6))
cam_d = bpy.data.cameras.new("C"); cam = bpy.data.objects.new("C", cam_d); bpy.context.scene.collection.objects.link(cam)
cam.location = (H * 0.55, -H * 1.4, ctr.z + H * 0.18)
look = mathutils.Vector(ctr) - mathutils.Vector(cam.location); cam.rotation_euler = look.to_track_quat('-Z', 'Y').to_euler(); bpy.context.scene.camera = cam
ld = bpy.data.lights.new("L", 'SUN'); lo = bpy.data.objects.new("L", ld); bpy.context.scene.collection.objects.link(lo); ld.energy = 2.8; lo.rotation_euler = (math.radians(48), math.radians(12), math.radians(32))
fd = bpy.data.lights.new("F", 'AREA'); fo = bpy.data.objects.new("F", fd); bpy.context.scene.collection.objects.link(fo); fd.energy = 200; fo.location = (-3, -3, 3)
w = bpy.data.worlds.new("W"); w.use_nodes = True; w.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.62, 0.78, 1); bpy.context.scene.world = w
sc = bpy.context.scene; sc.render.engine = 'BLENDER_EEVEE_NEXT'; sc.render.resolution_x = 420; sc.render.resolution_y = 640; sc.render.filepath = render
sc.view_settings.view_transform = 'AgX'; sc.view_settings.exposure = -0.1
bpy.ops.render.render(write_still=True); print("RENDER", render)
