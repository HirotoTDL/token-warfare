import bpy, sys, math, os
argv = sys.argv[sys.argv.index("--")+1:]
src, out = argv[0], argv[1]
# クリア
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
# 対象メッシュのbboxからカメラを配置
objs=[o for o in bpy.data.objects if o.type=='MESH']
import mathutils
mn=mathutils.Vector(( 1e9,)*3); mx=mathutils.Vector((-1e9,)*3)
for o in objs:
    for c in o.bound_box:
        w=o.matrix_world @ mathutils.Vector(c)
        mn=mathutils.Vector((min(mn[i],w[i]) for i in range(3)))
        mx=mathutils.Vector((max(mx[i],w[i]) for i in range(3)))
ctr=(mn+mx)/2; size=(mx-mn); h=size.z
cam_d=bpy.data.cameras.new("C"); cam=bpy.data.objects.new("C",cam_d); bpy.context.scene.collection.objects.link(cam)
cam.location=(ctr.x, ctr.y - h*2.2, ctr.z + h*0.15)
cam.rotation_euler=(math.radians(88),0,0)
bpy.context.scene.camera=cam
# ライト
ld=bpy.data.lights.new("L",'SUN'); lo=bpy.data.objects.new("L",ld); bpy.context.scene.collection.objects.link(lo)
ld.energy=4; lo.rotation_euler=(math.radians(55),math.radians(20),0)
bpy.context.scene.world=bpy.data.worlds.new("W"); bpy.context.scene.world.use_nodes=True
bpy.context.scene.world.node_tree.nodes["Background"].inputs[0].default_value=(0.85,0.85,0.92,1)
# レンダ設定
sc=bpy.context.scene; sc.render.engine='BLENDER_EEVEE_NEXT'; sc.render.resolution_x=320; sc.render.resolution_y=400
sc.render.film_transparent=False; sc.render.filepath=out
bpy.ops.render.render(write_still=True)
print("RENDERED", out, "meshes", len(objs), "height %.2f"%h)
