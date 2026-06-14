import bpy, sys, math, mathutils, numpy as np
a=sys.argv[sys.argv.index("--")+1:]
target,out,render = a[0],a[1],(a[2] if len(a)>2 else "")
def bbox(objs):
    mn=mathutils.Vector((1e9,1e9,1e9)); mx=mathutils.Vector((-1e9,-1e9,-1e9))
    for o in objs:
        for c in o.bound_box:
            w=o.matrix_world@mathutils.Vector(c)
            for i in range(3): mn[i]=min(mn[i],w[i]); mx[i]=max(mx[i],w[i])
    return mn,mx
bpy.ops.wm.read_factory_settings(use_empty=True)
before=set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=target)
tmesh=[o for o in bpy.data.objects if o not in before and o.type=='MESH']
for o in [o for o in bpy.data.objects if o not in before and o.type!='MESH']:
    try: bpy.data.objects.remove(o,do_unlink=True)
    except: pass
mn,mx=bbox(tmesh); h=mx.z-mn.z; b=mn.z; cx=(mn.x+mx.x)/2; cy=(mn.y+mx.y)/2
def Z(f): return b+f*h
hipw=0.10*h; shw=0.13*h
arm_data=bpy.data.armatures.new("Armature"); arm=bpy.data.objects.new("Armature",arm_data)
bpy.context.scene.collection.objects.link(arm); bpy.context.view_layer.objects.active=arm
bpy.ops.object.mode_set(mode='EDIT'); eb=arm_data.edit_bones
segs={}  # name -> (head world vec, tail world vec)
def mk(n,hd,tl,p=None,c=False):
    bn=eb.new(n); bn.head=mathutils.Vector(hd); bn.tail=mathutils.Vector(tl)
    if p: bn.parent=p; bn.use_connect=c
    segs[n]=(np.array(hd,dtype=np.float32),np.array(tl,dtype=np.float32))
    return bn
Hip=mk('Hip',(cx,cy,Z(0.44)),(cx,cy,Z(0.50)))
Waist=mk('Waist',(cx,cy,Z(0.50)),(cx,cy,Z(0.58)),Hip,True)
S1=mk('Spine01',(cx,cy,Z(0.58)),(cx,cy,Z(0.66)),Waist,True)
S2=mk('Spine02',(cx,cy,Z(0.66)),(cx,cy,Z(0.72)),S1,True)
Neck=mk('NeckTwist01',(cx,cy,Z(0.72)),(cx,cy,Z(0.78)),S2,True)
Head=mk('Head',(cx,cy,Z(0.78)),(cx,cy,Z(0.92)),Neck,True)
for s,sx in [('L',1),('R',-1)]:
    Cl=mk(s+'_Clavicle',(cx,cy,Z(0.70)),(cx+sx*shw,cy,Z(0.70)),S2,False)
    Up=mk(s+'_Upperarm',(cx+sx*shw,cy,Z(0.70)),(cx+sx*shw*1.9,cy,Z(0.52)),Cl,True)
    Fo=mk(s+'_Forearm',(cx+sx*shw*1.9,cy,Z(0.52)),(cx+sx*shw*2.6,cy,Z(0.36)),Up,True)
    mk(s+'_Hand',(cx+sx*shw*2.6,cy,Z(0.36)),(cx+sx*shw*3.0,cy,Z(0.30)),Fo,True)
    Th=mk(s+'_Thigh',(cx+sx*hipw,cy,Z(0.44)),(cx+sx*hipw,cy,Z(0.24)),Hip,False)
    Ca=mk(s+'_Calf',(cx+sx*hipw,cy,Z(0.24)),(cx+sx*hipw,cy,Z(0.04)),Th,True)
    mk(s+'_Foot',(cx+sx*hipw,cy,Z(0.04)),(cx+sx*hipw,cy-0.10*h,Z(0.0)),Ca,True)
bpy.ops.object.mode_set(mode='OBJECT')
# アーマチュア・モディファイア＋空頂点グループのみ付与(ウェイトは自前計算)
bpy.ops.object.select_all(action='DESELECT')
for m in tmesh: m.select_set(True)
arm.select_set(True); bpy.context.view_layer.objects.active=arm
bpy.ops.object.parent_set(type='ARMATURE_NAME')
# 距離ベース・スキニング(numpyベクトル化)。各頂点を最近傍K本に逆二乗距離でブレンド。
names=list(segs.keys())
H=np.stack([segs[n][0] for n in names]); T=np.stack([segs[n][1] for n in names])
AB=T-H; ab2=np.sum(AB*AB,axis=1); ab2[ab2<1e-9]=1e-9
K=2
for m in tmesh:
    n=len(m.data.vertices)
    co=np.empty(n*3,dtype=np.float32); m.data.vertices.foreach_get('co',co); co=co.reshape(n,3)
    M=np.array(m.matrix_world,dtype=np.float32)
    cow=co@M[:3,:3].T+M[:3,3]   # ワールド座標
    # 各ボーン線分への点-線分距離 (n x B)
    B=len(names); dist=np.empty((n,B),dtype=np.float32)
    for j in range(B):
        ap=cow-H[j]; t=np.clip((ap@AB[j])/ab2[j],0,1)
        proj=H[j]+np.outer(t,AB[j]); d=cow-proj; dist[:,j]=np.sqrt(np.sum(d*d,axis=1))
    order=np.argsort(dist,axis=1)[:,:K]
    vgs=[m.vertex_groups.get(nm) for nm in names]
    # 逆二乗ウェイト(最近傍K本ブレンド)。同一ウェイト量子化でadd呼び出しをバッチ化し高速化。
    dsel=np.take_along_axis(dist,order,axis=1)+1e-4
    w=1.0/(dsel*dsel); w/=w.sum(axis=1,keepdims=True)
    buckets={}  # (bone_idx, quantized_weight) -> [vertex...]
    for v in range(n):
        for k in range(K):
            bi=int(order[v,k]); q=round(float(w[v,k]),3)
            if q<=0: continue
            buckets.setdefault((bi,q),[]).append(v)
    for (bi,q),verts in buckets.items():
        vgs[bi].add(verts,q,'REPLACE')
    print("skinned",m.name,n,"verts")
# 検証用ポーズレンダ(任意)
if render:
    bpy.context.view_layer.objects.active=arm; bpy.ops.object.mode_set(mode='POSE')
    for bn,ax,ang in [('L_Thigh','X',50),('R_Thigh','X',-50),('L_Calf','X',-60),('R_Upperarm','X',45)]:
        pb=arm.pose.bones.get(bn)
        if pb: pb.rotation_mode='XYZ'; setattr(pb.rotation_euler,ax.lower(),math.radians(ang))
    bpy.ops.object.mode_set(mode='OBJECT')
    ctr=(mn+mx)/2
    cd=bpy.data.cameras.new("C"); cam=bpy.data.objects.new("C",cd); bpy.context.scene.collection.objects.link(cam)
    cam.location=(ctr.x+h*0.7,ctr.y-h*2.2,ctr.z+h*0.15); cam.rotation_euler=(math.radians(86),0,math.radians(18)); bpy.context.scene.camera=cam
    ld=bpy.data.lights.new("L",'SUN'); lo=bpy.data.objects.new("L",ld); bpy.context.scene.collection.objects.link(lo); ld.energy=4; lo.rotation_euler=(math.radians(55),math.radians(20),0)
    bpy.context.scene.world=bpy.data.worlds.new("W"); bpy.context.scene.world.use_nodes=True; bpy.context.scene.world.node_tree.nodes["Background"].inputs[0].default_value=(0.85,0.85,0.92,1)
    sc=bpy.context.scene; sc.render.engine='BLENDER_EEVEE_NEXT'; sc.render.resolution_x=340; sc.render.resolution_y=440; sc.render.filepath=render
    bpy.ops.render.render(write_still=True); print("RENDER",render)
    # レスト姿勢へ戻す
    bpy.context.view_layer.objects.active=arm; bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.select_all(action='SELECT'); bpy.ops.pose.transforms_clear(); bpy.ops.object.mode_set(mode='OBJECT')
# リグ済みGLBエクスポート(スキン保持)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_skins=True,
    export_yup=True, use_selection=True, export_apply=False)
print("EXPORT",out)
print("DONE autorig")
