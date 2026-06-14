# メッシュ変形実験: リグ済みGLBの頂点グループ(Head/Thigh等)を使い、
# 頭部を拡大・脚を短縮してチビ体型バリエーションを作る(直接頂点変形)。
import bpy, math, mathutils, numpy as np, sys
a=sys.argv[sys.argv.index("--")+1:]
src,out,render = a[0],a[1],a[2]
bpy.ops.wm.read_factory_settings(use_empty=True)
before=set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=src)
meshes=[o for o in bpy.data.objects if o.type=='MESH']
def group_weights(m,name):
    gi=m.vertex_groups.find(name)
    n=len(m.data.vertices); w=np.zeros(n,dtype=np.float32)
    if gi<0: return w
    for v in m.data.vertices:
        for g in v.groups:
            if g.group==gi: w[v.index]=g.weight
    return w
for m in meshes:
    n=len(m.data.vertices)
    co=np.empty(n*3,dtype=np.float32); m.data.vertices.foreach_get('co',co); co=co.reshape(n,3)
    wh=group_weights(m,'Head'); wn=group_weights(m,'NeckTwist01')
    whead=np.clip(wh+0.5*wn,0,1)
    # 頭の重心
    if whead.sum()>1:
        hc=(co*whead[:,None]).sum(0)/whead.sum()
        co=co+(co-hc)*(whead[:,None]*0.45)  # 頭を最大1.45倍に膨らませる
    # 脚を短縮: Thigh/Calf/Foot重みの頂点を足元基準に縦圧縮
    wl=np.clip(group_weights(m,'L_Calf')+group_weights(m,'R_Calf')+group_weights(m,'L_Thigh')+group_weights(m,'R_Thigh'),0,1)
    if wl.sum()>1:
        zmin=co[:,2].min()
        co[:,2]=co[:,2]-(co[:,2]-zmin)*(wl*0.30)  # 脚を最大30%縮める
    m.data.vertices.foreach_set('co',co.reshape(-1)); m.data.update()
print("reshaped")
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=out,export_format='GLB',use_selection=True,export_yup=True,export_skins=True)
print("EXPORT",out)
mn=mathutils.Vector((1e9,)*3); mx=mathutils.Vector((-1e9,)*3)
for o in meshes:
    for c in o.bound_box:
        w=o.matrix_world@mathutils.Vector(c)
        for i in range(3): mn[i]=min(mn[i],w[i]); mx[i]=max(mx[i],w[i])
ctr=(mn+mx)/2; h=mx.z-mn.z
cam_d=bpy.data.cameras.new("C"); cam=bpy.data.objects.new("C",cam_d); bpy.context.scene.collection.objects.link(cam)
cam.location=(ctr.x,ctr.y-h*2.0,ctr.z+h*0.05)
look=mathutils.Vector((ctr.x,ctr.y,ctr.z))-mathutils.Vector(cam.location)
cam.rotation_euler=look.to_track_quat('-Z','Y').to_euler(); bpy.context.scene.camera=cam
ld=bpy.data.lights.new("L",'SUN'); lo=bpy.data.objects.new("L",ld); bpy.context.scene.collection.objects.link(lo); ld.energy=3.0; lo.rotation_euler=(math.radians(52),math.radians(10),math.radians(25))
w=bpy.data.worlds.new("W"); w.use_nodes=True; w.node_tree.nodes["Background"].inputs[0].default_value=(0.75,0.80,0.90,1); bpy.context.scene.world=w
sc=bpy.context.scene; sc.render.engine='BLENDER_EEVEE_NEXT'; sc.render.resolution_x=360; sc.render.resolution_y=440; sc.render.filepath=render; sc.view_settings.view_transform='AgX'
bpy.ops.render.render(write_still=True); print("RENDER",render)
