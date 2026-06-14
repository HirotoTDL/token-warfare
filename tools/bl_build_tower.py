# ゼロから手続き的にフェアリィの塔を構築する実験。
# プリミティブ(円柱/円錐/トーラス/球)+ modifier(bevel/subsurf) を組み合わせ、
# パステル材質を割り当ててGLBエクスポート＋検証レンダ。
import bpy, math, mathutils, sys
a=sys.argv[sys.argv.index("--")+1:]
out,render=a[0],a[1]
bpy.ops.wm.read_factory_settings(use_empty=True)

def mat(name,rgb,rough=0.6,emit=None):
    m=bpy.data.materials.new(name); m.use_nodes=True
    b=m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value=(*rgb,1); b.inputs["Roughness"].default_value=rough
    if emit:
        b.inputs["Emission Color"].default_value=(*emit,1); b.inputs["Emission Strength"].default_value=2.0
    return m
M_wall=mat("wall",(0.86,0.80,0.84),0.7)
M_roof=mat("roof",(0.62,0.78,0.95),0.4)
M_band=mat("band",(0.95,0.62,0.80),0.5)
M_win =mat("win",(0.55,0.92,0.86),0.2,emit=(0.4,0.95,0.85))
M_gold=mat("gold",(0.98,0.82,0.45),0.3,emit=(0.5,0.4,0.1))

objs=[]
def add(o,m):
    o.data.materials.append(m); objs.append(o); return o

# --- 塔本体: 上に向かって少しすぼまる円柱を3段スタック ---
seg=[(2.4,0,3.0),(2.0,3.0,3.2),(1.6,6.2,2.6)]  # (半径, 底Z, 高さ)
for r,z,hh in seg:
    bpy.ops.mesh.primitive_cylinder_add(vertices=24,radius=r,depth=hh,location=(0,0,z+hh/2))
    add(bpy.context.object,M_wall)
    # 段ごとの装飾リング(トーラス)
    bpy.ops.mesh.primitive_torus_add(major_radius=r*1.02,minor_radius=0.14,location=(0,0,z+0.1),major_segments=24,minor_segments=8)
    add(bpy.context.object,M_band)

# --- 窓: 各段にarray状に配置(小さな発光ボックス) ---
for r,z,hh in seg:
    n=6
    for k in range(n):
        ang=k/n*math.tau
        bpy.ops.mesh.primitive_cube_add(size=0.5,location=((r-0.05)*math.cos(ang),(r-0.05)*math.sin(ang),z+hh*0.55))
        o=bpy.context.object; o.scale=(0.16,0.16,0.34); o.rotation_euler=(0,0,ang)
        add(o,M_win)

# --- 円錐の屋根 + 先端の球(宝珠) ---
bpy.ops.mesh.primitive_cone_add(vertices=24,radius1=2.0,radius2=0,depth=3.2,location=(0,0,8.8+1.6))
add(bpy.context.object,M_roof)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.4,location=(0,0,8.8+3.4))
add(bpy.context.object,M_gold)

# --- バルコニー(2段目の張り出しリング) ---
bpy.ops.mesh.primitive_cylinder_add(vertices=24,radius=2.4,depth=0.25,location=(0,0,6.1))
add(bpy.context.object,M_band)

# --- 入口アーチ(ブーリアンで本体に穴) ---
bpy.ops.mesh.primitive_cube_add(size=1.0,location=(2.2,0,1.1)); door=bpy.context.object; door.scale=(0.6,0.5,1.0)
bpy.ops.mesh.primitive_cylinder_add(vertices=16,radius=0.5,depth=1.0,rotation=(math.pi/2,0,0),location=(2.2,0,1.6)); arch=bpy.context.object; arch.scale=(1,1,0.6)

# 全体にbevel+subsurfでソフトな印象に(本体メッシュのみ)
for o in objs:
    if o.type!='MESH': continue
    bpy.context.view_layer.objects.active=o
    bv=o.modifiers.new("bevel",'BEVEL'); bv.width=0.03; bv.segments=2

# エクスポート(装飾全部選択)
bpy.ops.object.select_all(action='DESELECT')
for o in objs: o.select_set(True)
door.select_set(False); arch.select_set(False)
# door/archはブーリアン用なので削除
bpy.data.objects.remove(door,do_unlink=True); bpy.data.objects.remove(arch,do_unlink=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=out,export_format='GLB',use_selection=True,export_yup=True)
print("EXPORT",out)

# 地面(文脈用)
bpy.ops.mesh.primitive_plane_add(size=60,location=(0,0,0))
gp=bpy.context.object; gp.data.materials.append(mat("ground",(0.80,0.92,0.80),0.9))
# レンダ(全体が入るよう引き＋見上げ気味)
cam_d=bpy.data.cameras.new("C"); cam=bpy.data.objects.new("C",cam_d); bpy.context.scene.collection.objects.link(cam)
cam.location=(17,-22,9)
look=mathutils.Vector((0,0,5.5))-mathutils.Vector(cam.location)
cam.rotation_euler=look.to_track_quat('-Z','Y').to_euler(); bpy.context.scene.camera=cam
ld=bpy.data.lights.new("L",'SUN'); lo=bpy.data.objects.new("L",ld); bpy.context.scene.collection.objects.link(lo); ld.energy=2.6; lo.rotation_euler=(math.radians(48),math.radians(12),math.radians(35))
fd=bpy.data.lights.new("F",'SUN'); fo=bpy.data.objects.new("F",fd); bpy.context.scene.collection.objects.link(fo); fd.energy=0.6; fo.rotation_euler=(math.radians(70),0,math.radians(-120))
w=bpy.data.worlds.new("W"); w.use_nodes=True; w.node_tree.nodes["Background"].inputs[0].default_value=(0.42,0.52,0.72,1); bpy.context.scene.world=w
sc=bpy.context.scene; sc.render.engine='BLENDER_EEVEE_NEXT'; sc.render.resolution_x=460; sc.render.resolution_y=620; sc.render.filepath=render
sc.view_settings.view_transform='AgX'; sc.view_settings.exposure=-0.3
bpy.ops.render.render(write_still=True); print("RENDER",render)
