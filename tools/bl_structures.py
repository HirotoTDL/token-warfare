# 商業レベル構造物ビルダー(headless)。kind引数で種別を切替、既存GPTテクスチャをタイル貼りして
# 作り込んだGLBを出力。テクスチャはGenerated座標+Mappingでタイル(UV展開不要・確実)。
import bpy, math, mathutils, sys, os
a = sys.argv[sys.argv.index("--") + 1:]
kind, out, render = a[0], a[1], a[2]
ART = os.path.abspath("public/art")
bpy.ops.wm.read_factory_settings(use_empty=True)
OBJS = []


def tex_mat(name, tex, scale=2.0, rough=0.6, metal=0.0, emit=None, ecol=(1, 1, 1), emit_from_tex=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if tex:
        img = bpy.data.images.load(os.path.join(ART, tex), check_existing=True)
        tc = nt.nodes.new("ShaderNodeTexCoord"); mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (scale, scale, scale)
        ti = nt.nodes.new("ShaderNodeTexImage"); ti.image = img; ti.projection = 'BOX'; ti.extension = 'REPEAT'
        nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
        nt.links.new(mp.outputs["Vector"], ti.inputs["Vector"])
        nt.links.new(ti.outputs["Color"], bsdf.inputs["Base Color"])
        if emit_from_tex > 0:
            # テクスチャの明部(発光ルーン等)をそのまま自発光させる
            nt.links.new(ti.outputs["Color"], bsdf.inputs["Emission Color"])
            bsdf.inputs["Emission Strength"].default_value = emit_from_tex
    if emit is not None:
        bsdf.inputs["Emission Color"].default_value = (*ecol, 1)
        bsdf.inputs["Emission Strength"].default_value = emit
    return m


def solid_mat(name, rgb, rough=0.5, metal=0.0, emit=None):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit is not None:
        b.inputs["Emission Color"].default_value = (*rgb, 1)
        b.inputs["Emission Strength"].default_value = emit
    return m


def add(prim, mat, **kw):
    getattr(bpy.ops.mesh, prim)(**kw); o = bpy.context.object
    if mat:
        o.data.materials.append(mat)
    OBJS.append(o); return o


def bevel(o, w=0.02, seg=2):
    bpy.context.view_layer.objects.active = o
    mod = o.modifiers.new("b", 'BEVEL'); mod.width = w; mod.segments = seg; mod.limit_method = 'ANGLE'


def cut_below(o, zlevel):
    """zlevel未満の頂点を削除(半トーラス等の整形)"""
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.object.mode_set(mode='OBJECT')
    for v in o.data.vertices:
        if (o.matrix_world @ v.co).z < zlevel - 0.01:
            v.select = True
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.delete(type='VERT'); bpy.ops.object.mode_set(mode='OBJECT')


# ---- マテリアル(世界観の既存テクスチャを流用) ----
MARBLE = tex_mat("marble", "tex_pearl_marble_floor.png", 2.5, 0.35)
STONE = tex_mat("stone", "tex_magic_stone_blocks.png", 2.0, 0.7)
MOLD = tex_mat("mold", "tex_cream_gold_molding.png", 1.5, 0.4, 0.2)
JEWEL = tex_mat("jewel", "tex_jewel_inlay_panel.png", 1.2, 0.3, metal=0.3)
RUNE = tex_mat("rune", "tex_glowing_rune_floor.png", 2.0, 0.4, emit=0.6, ecol=(0.5, 0.9, 1.0))
GOLD = solid_mat("gold", (0.95, 0.78, 0.38), 0.25, 1.0)
CRYST = solid_mat("crystal", (0.6, 0.92, 0.95), 0.1, 0.0, emit=1.6)
# GPT発注の専用テクスチャ(商業レベル化)
COLUMN = tex_mat("column", "tex_fluted_marble_column.png", 3.0, 0.3)
GATESTONE = tex_mat("gatestone", "tex_carved_fairy_gate.png", 1.4, 0.6)
OBELISKSTONE = tex_mat("obeliskstone", "tex_rune_obelisk.png", 1.0, 0.45, emit_from_tex=1.4)
BRONZE = tex_mat("bronze", "tex_ornate_bronze.png", 1.0, 0.35, metal=0.85)


def build_pillar():
    add('primitive_cylinder_add', MOLD, vertices=8, radius=0.95, depth=0.35, location=(0, 0, 0.175))
    add('primitive_cylinder_add', MARBLE, vertices=8, radius=0.78, depth=0.22, location=(0, 0, 0.46))
    add('primitive_cone_add', COLUMN, vertices=24, radius1=0.62, radius2=0.5, depth=4.4, location=(0, 0, 2.77))
    for z in (0.62, 4.92):
        add('primitive_torus_add', GOLD, major_radius=0.6, minor_radius=0.06, location=(0, 0, z), major_segments=24, minor_segments=8)
    add('primitive_cone_add', MOLD, vertices=24, radius1=0.52, radius2=0.92, depth=0.55, location=(0, 0, 5.25))
    add('primitive_cylinder_add', JEWEL, vertices=4, radius=0.95, depth=0.35, location=(0, 0, 5.7), rotation=(0, 0, math.radians(45)))
    add('primitive_uv_sphere_add', CRYST, radius=0.22, location=(0, 0, 6.05))


def build_canopy():
    add('primitive_cylinder_add', MOLD, vertices=8, radius=4.6, depth=0.4, location=(0, 0, 0.2))
    add('primitive_cone_add', STONE, vertices=8, radius1=4.3, radius2=2.6, depth=1.2, location=(0, 0, 1.0))
    add('primitive_cone_add', JEWEL, vertices=8, radius1=2.6, radius2=1.1, depth=1.2, location=(0, 0, 2.2))
    add('primitive_cone_add', MOLD, vertices=8, radius1=1.2, radius2=0, depth=1.6, location=(0, 0, 3.4))
    add('primitive_uv_sphere_add', CRYST, radius=0.3, location=(0, 0, 4.3))
    for k in range(8):
        ang = k / 8 * math.tau
        add('primitive_ico_sphere_add', CRYST, radius=0.16, location=(4.4 * math.cos(ang), 4.4 * math.sin(ang), 0.45), subdivisions=2)


def build_gate():
    for sx in (-1, 1):
        add('primitive_cylinder_add', GATESTONE, vertices=8, radius=0.7, depth=5.2, location=(sx * 3.0, 0, 2.6))
        add('primitive_cylinder_add', MOLD, vertices=8, radius=0.82, depth=0.4, location=(sx * 3.0, 0, 0.2))
        add('primitive_cylinder_add', MOLD, vertices=8, radius=0.8, depth=0.4, location=(sx * 3.0, 0, 5.0))
    arch = add('primitive_torus_add', GATESTONE, major_radius=3.0, minor_radius=0.55, location=(0, 0, 5.2), major_segments=32, minor_segments=12)
    arch.rotation_euler = (math.radians(90), 0, 0)
    cut_below(arch, 5.2)
    add('primitive_cube_add', MOLD, size=1.0, location=(0, 0, 7.9)); OBJS[-1].scale = (0.55, 0.7, 0.7)
    add('primitive_ico_sphere_add', CRYST, radius=0.4, location=(0, 0, 8.5), subdivisions=2)
    g = add('primitive_torus_add', GOLD, major_radius=3.0, minor_radius=0.08, location=(0, 0, 5.2), major_segments=32, minor_segments=8)
    g.rotation_euler = (math.radians(90), 0, 0); cut_below(g, 5.2)


def build_railing():
    # 欄干セグメント(長さ約2.4): 下台座 + 親柱2本 + 上レール + バラスター + ジュエル
    add('primitive_cube_add', MARBLE, size=1.0, location=(0, 0, 0.12)); OBJS[-1].scale = (1.2, 0.16, 0.16)
    for sx in (-1, 1):
        add('primitive_cylinder_add', MOLD, vertices=8, radius=0.13, depth=1.05, location=(sx * 1.15, 0, 0.52))
        add('primitive_uv_sphere_add', GOLD, radius=0.12, location=(sx * 1.15, 0, 1.08))
    add('primitive_cube_add', MOLD, size=1.0, location=(0, 0, 0.92)); OBJS[-1].scale = (1.18, 0.1, 0.1)
    for i in range(5):
        x = (i - 2) * 0.46
        add('primitive_cylinder_add', MARBLE, vertices=8, radius=0.07, depth=0.62, location=(x, 0, 0.55))
        add('primitive_uv_sphere_add', JEWEL, radius=0.08, location=(x, 0, 0.55))


def build_island():
    # 浮遊島: 上面の草ディスク + 岩塊(下に向かって尖る) + 露出クリスタル
    GRASS = tex_mat("grass", "tex_grass_flower_meadow.png", 2.0, 0.85)
    add('primitive_cylinder_add', GRASS, vertices=20, radius=3.0, depth=0.5, location=(0, 0, 0))
    add('primitive_cone_add', STONE, vertices=20, radius1=2.9, radius2=0.3, depth=3.6, location=(0, 0, -2.05))
    for k in range(5):
        ang = k / 5 * math.tau
        add('primitive_cone_add', CRYST, vertices=6, radius1=0.28, radius2=0, depth=1.3, location=(1.6 * math.cos(ang), 1.6 * math.sin(ang), -1.6), rotation=(math.radians(160 + 10 * k), 0, ang))
    add('primitive_uv_sphere_add', CRYST, radius=0.45, location=(0, 0, -3.6))


def build_brazier():
    # かがり火: 台座 + 脚付きボウル + 発光コア + 炎(エミッシブコーン)
    FLAME = solid_mat("flame", (1.0, 0.5, 0.18), 0.4, 0.0, emit=9.0)
    add('primitive_cylinder_add', BRONZE, vertices=12, radius=0.6, depth=0.35, location=(0, 0, 0.175))
    add('primitive_cone_add', BRONZE, vertices=12, radius1=0.22, radius2=0.55, depth=1.3, location=(0, 0, 0.95))
    add('primitive_torus_add', GOLD, major_radius=0.62, minor_radius=0.09, location=(0, 0, 1.6), major_segments=20, minor_segments=8)
    add('primitive_cylinder_add', FLAME, vertices=16, radius=0.55, depth=0.12, location=(0, 0, 1.58))
    add('primitive_cone_add', FLAME, vertices=12, radius1=0.42, radius2=0, depth=1.1, location=(0, 0, 2.1))
    add('primitive_uv_sphere_add', FLAME, radius=0.2, location=(0, 0, 1.75))


def build_obelisk():
    # ルーン・オベリスク: 段台座 + 4面テーパー柱(ルーン発光) + 金キャップ + 頂部クリスタル
    add('primitive_cylinder_add', MOLD, vertices=4, radius=1.1, depth=0.4, location=(0, 0, 0.2), rotation=(0, 0, math.radians(45)))
    add('primitive_cylinder_add', STONE, vertices=4, radius=0.85, depth=0.3, location=(0, 0, 0.5), rotation=(0, 0, math.radians(45)))
    add('primitive_cone_add', OBELISKSTONE, vertices=4, radius1=0.62, radius2=0.28, depth=5.4, location=(0, 0, 3.35), rotation=(0, 0, math.radians(45)))
    add('primitive_cone_add', GOLD, vertices=4, radius1=0.34, radius2=0, depth=0.7, location=(0, 0, 6.4), rotation=(0, 0, math.radians(45)))
    add('primitive_ico_sphere_add', CRYST, radius=0.26, location=(0, 0, 6.5), subdivisions=2)


BUILDERS = {'pillar': build_pillar, 'canopy': build_canopy, 'gate': build_gate,
            'railing': build_railing, 'island': build_island, 'brazier': build_brazier, 'obelisk': build_obelisk}
BUILDERS[kind]()
for o in list(OBJS):
    if o.type == 'MESH':
        bevel(o)

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
bpy.context.object.data.materials.append(tex_mat("g", "tex_pastel_cobblestone.png", 6, 0.85))
cam_d = bpy.data.cameras.new("C"); cam = bpy.data.objects.new("C", cam_d); bpy.context.scene.collection.objects.link(cam)
cam.location = (ctr.x + H * 0.7, ctr.y - H * 1.7, ctr.z + H * 0.35)
look = mathutils.Vector(ctr) - mathutils.Vector(cam.location)
cam.rotation_euler = look.to_track_quat('-Z', 'Y').to_euler(); bpy.context.scene.camera = cam
ld = bpy.data.lights.new("L", 'SUN'); lo = bpy.data.objects.new("L", ld); bpy.context.scene.collection.objects.link(lo); ld.energy = 2.6; lo.rotation_euler = (math.radians(50), math.radians(12), math.radians(30))
fd = bpy.data.lights.new("F", 'SUN'); fo = bpy.data.objects.new("F", fd); bpy.context.scene.collection.objects.link(fo); fd.energy = 0.5; fo.rotation_euler = (math.radians(65), 0, math.radians(-110))
w = bpy.data.worlds.new("W"); w.use_nodes = True; w.node_tree.nodes["Background"].inputs[0].default_value = (0.5, 0.6, 0.78, 1); bpy.context.scene.world = w
sc = bpy.context.scene; sc.render.engine = 'BLENDER_EEVEE_NEXT'; sc.render.resolution_x = 480; sc.render.resolution_y = 560; sc.render.filepath = render
sc.view_settings.view_transform = 'AgX'; sc.view_settings.exposure = -0.2
bpy.ops.render.render(write_still=True); print("RENDER", render)
