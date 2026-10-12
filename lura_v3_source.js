(()=>{
'use strict';
const $=id=>document.getElementById(id);
const preview=$('preview'), canvas=$('glow'), ctx=canvas.getContext('2d',{alpha:false}), video=$('camera');
const mobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)||((navigator.maxTouchPoints||0)>1&&/Macintosh/i.test(navigator.userAgent));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const pt=(x,y)=>({x,y});
const midpoint=(a,b)=>pt((a.x+b.x)/2,(a.y+b.y)/2);
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const defaults={hue:343,saturation:82,brightness:70,size:72,softness:89,gap:70,vertical:66,ambient:47,hatScale:100,hatTilt:7,speed:30};
const presets={rose:{...defaults},peach:{...defaults,hue:19,saturation:64,brightness:53},violet:{...defaults,hue:275,saturation:65,brightness:51},aqua:{...defaults,hue:186,saturation:62,brightness:58},sunset:{...defaults,hue:8,saturation:81,brightness:65,ambient:63},custom:{...defaults}};
const config=[
 ['hue','Hue',0,360,'°'],['saturation','Saturation',0,100,'%'],['brightness','LED intensity',0,100,'%'],
 ['size','Face coverage',10,100,'%'],['softness','Edge feathering',0,100,'%'],['gap','Light width',20,100,'%'],
 ['vertical','Downward reach',10,100,'%'],['ambient','Light diffusion',0,100,'%'],
 ['hatScale','Hat fit',70,135,'%'],['hatTilt','Brim tilt',-20,30,'°'],['speed','Pulse speed',5,100,'%']
];
let settings={...defaults},chosen='rose',mode='face',hatVisible=true,animate=false;
let stream=null,requestToken=0,tracker=null,trackerLoading=false,trackerError='',lastFrameVideoTime=-1;
let trackedLandmarks=null,pose=null,lastFaceAt=0,lastDetectionAt=0,frameId=0,lastHint='';
let sampleFaceImg=null,samplePovImg=null;
let offscreen=null,light=null,mask=null,offscreenW=0,offscreenH=0;
let lastFrameAt=0;
const sliders=$('sliders');
for(const [key,label,min,max,unit] of config){
 const wrap=document.createElement('div');wrap.className='sliderr';
 wrap.innerHTML=`<div class="sliderhead"><label for="${key}">${label}</label><output id="${key}Value"></output></div><input class="slider${key==='hue'?' hue':''}" id="${key}" type="range" min="${min}" max="${max}" value="${settings[key]}" step="1" aria-label="${label}">`;
 sliders.append(wrap);
 $(key).addEventListener('input',()=>{settings[key]=Number($(key).value);chosen='custom';sync();});
}
function sync(){
 for(const [key,,min,max,unit] of config){$(key).value=settings[key];$(key+'Value').textContent=settings[key]+unit;$(key).style.setProperty('--fill',`${(settings[key]-min)/(max-min)*100}%`);}
 for(const item of document.querySelectorAll('[data-preset]')){const on=item.dataset.preset===chosen;item.classList.toggle('selected',on);item.setAttribute('aria-pressed',String(on));}
 $('activeLook').textContent=chosen==='custom'?'CUSTOM MIX':chosen==='rose'?'ROSE BLUSH':chosen.toUpperCase();
}
sync();
$('presets').addEventListener('click',e=>{const btn=e.target.closest('[data-preset]');if(!btn)return;chosen=btn.dataset.preset;if(chosen!=='custom')settings={...presets[chosen]};sync();});
$('resetBtn').addEventListener('click',()=>{chosen='rose';settings={...defaults};animate=false;$('animateBtn').setAttribute('aria-pressed','false');sync();});
$('animateBtn').addEventListener('click',()=>{animate=!animate;$('animateBtn').setAttribute('aria-pressed',String(animate));});
function setHat(v){hatVisible=v;for(const [id,on] of [['withoutHat',!v],['withHat',v]]){const btn=$(id);btn.classList.toggle('active',on);btn.setAttribute('aria-pressed',String(on));}$('cornerLabel').textContent=v?'HAT / ON':'HAT / HIDDEN';}
$('withHat').addEventListener('click',()=>setHat(true));$('withoutHat').addEventListener('click',()=>setHat(false));
setHat(true);
function setMode(v){if(v===mode)return;mode=v;preview.dataset.mode=v;for(const [id,on] of [['thirdTab',v==='face'],['firstTab',v==='pov']]){$(id).classList.toggle('active',on);$(id).setAttribute('aria-pressed',String(on));}
 $('modepill').textContent=v==='face'?'Third-person view':'First-person view';$('hatSelector').classList.toggle('hidden',v!=='face');
 $('demoFace').classList.toggle('hidden',v!=='face');$('demoPov').classList.toggle('hidden',v!=='pov');trackedLandmarks=null;pose=null;
 if(stream)startCamera();else updateHint();
}
$('thirdTab').addEventListener('click',()=>setMode('face'));
$('firstTab').addEventListener('click',()=>setMode('pov'));
function setHint(txt){if(txt!==lastHint){$('hint').textContent=txt;lastHint=txt;}}
function updateHint(){
 if(!stream){setHint(mode==='face'?'Demo mode · switch on your camera for tracked 3D fit':'Demo · enable the camera for first-person view');return;}
 if(mode==='pov'){setHint(mobile?'Rear camera · simulated down-facing LEDs':'Desktop camera · simulated down-facing LEDs');return;}
 if(trackedLandmarks&&performance.now()-lastFaceAt<1300){const p=pose||{yaw:0,pitch:0};setHint(`3D face lock · turn ${Math.round(p.yaw*180/Math.PI)}° · tilt ${Math.round(p.pitch*180/Math.PI)}°`);return;}
 if(trackerLoading){setHint('Loading 3D face and head rotation tracking…');return;}
 if(trackerError){setHint('Tracking unavailable · check internet and refresh');return;}
 setHint('Looking for your face · look toward the camera');
}
function stopCamera(){requestToken++;if(stream){stream.getTracks().forEach(x=>x.stop());stream=null;}video.pause();video.srcObject=null;video.classList.add('hidden');trackedLandmarks=null;pose=null;lastFrameVideoTime=-1;$('cameraBtn').textContent='◎ Enable camera';$('livebadge').textContent='✦ DEMO PREVIEW';updateHint();}
function facing(){return mode==='pov'&&mobile?'environment':'user';}
async function startCamera(){
 stopCamera();const token=requestToken;
 if(!navigator.mediaDevices?.getUserMedia){$('cameraInfo').textContent='Camera access requires localhost or HTTPS (such as GitHub Pages).';return;}
 $('cameraBtn').disabled=true;$('cameraBtn').textContent='Connecting…';
 try{
  const s=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:facing()},width:{ideal:1280},height:{ideal:960}}});
  if(token!==requestToken){s.getTracks().forEach(t=>t.stop());return;}
  stream=s;video.srcObject=s;await video.play();if(token!==requestToken)return;
  video.classList.remove('hidden');$('cameraBtn').textContent='□ Stop camera';$('livebadge').textContent='● LIVE CAMERA';
  $('cameraInfo').textContent='Camera and face tracking process locally in your browser. The model is downloaded once.';
  if(mode==='face')startTracking();updateHint();
 }catch(e){if(token!==requestToken)return;$('cameraInfo').textContent='Camera failed: '+(e.name==='NotAllowedError'?'camera permission denied':e.name==='NotFoundError'?'no camera found':e.name==='NotReadableError'?'another app is using the camera':e.message);$('cameraBtn').textContent='◎ Enable camera';}
 finally{if(token===requestToken)$('cameraBtn').disabled=false;}
}
$('cameraBtn').addEventListener('click',()=>{if(stream){stopCamera();$('cameraInfo').textContent='Camera is off. The illustration preview is active.';}else startCamera();});

// Face Landmarker returns hundreds of 3D face points AND a 4x4 transformation
// matrix. The matrix supplies yaw and pitch; eyes supply roll in screen space.
// That means the visor follows head turns and nods instead of just face position.
async function startTracking(){
 if(tracker||trackerLoading||!stream||mode!=='face')return;
 trackerLoading=true;trackerError='';updateHint();
 try{
  const pkg=await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/+esm');
  const vision=await pkg.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm');
  const options={baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',delegate:'GPU'},
    runningMode:'VIDEO',numFaces:1,minFaceDetectionConfidence:.52,minFacePresenceConfidence:.52,minTrackingConfidence:.52,
    outputFacialTransformationMatrixes:true,outputFaceBlendshapes:false};
  try{tracker=await pkg.FaceLandmarker.createFromOptions(vision,options);}
  catch(e){options.baseOptions.delegate='CPU';tracker=await pkg.FaceLandmarker.createFromOptions(vision,options);}
  $('cameraInfo').textContent='3D head tracking enabled: follows side-to-side turns, nods and head tilt. Face video stays on this device.';
 }catch(e){trackerError=String(e?.message||e);$('cameraInfo').textContent='3D tracking could not load. Check your connection, disable content blockers for the MediaPipe CDN, then reload. '+trackerError;}
 finally{trackerLoading=false;updateHint();}
}
function updateTracking(t){
 if(!stream||mode!=='face'||!tracker||video.readyState<2||t-lastDetectionAt<66||video.currentTime===lastFrameVideoTime)return;
 lastDetectionAt=t;lastFrameVideoTime=video.currentTime;
 try{
  const results=tracker.detectForVideo(video,t),face=results.faceLandmarks?.[0];
  if(!face?.length){if(t-lastFaceAt>550){trackedLandmarks=null;pose=null;}return;}
  // The visual camera is mirrored for selfies. The 3D matrix comes from the
  // non-mirrored video, so yaw changes sign to match the on-screen view.
  const matrix=results.facialTransformationMatrixes?.[0]?.data;
  const R=matrix&&matrix.length===16?matrix:null;
  const newYaw=R?clamp(-Math.atan2(R[2],R[10]),-1.28,1.28):0;
  const newPitch=R?clamp(Math.atan2(-R[6],Math.hypot(R[2],R[10])),-.85,.85):0;
  // Lerp landmarks in normalized video coordinates to reduce cap edge jitter.
  if(!trackedLandmarks||trackedLandmarks.length!==face.length){trackedLandmarks=face.map(p=>({...p}));}
  else{const a=.48;for(let i=0;i<face.length;i++){let p=trackedLandmarks[i];p.x=lerp(p.x,face[i].x,a);p.y=lerp(p.y,face[i].y,a);p.z=lerp(p.z,face[i].z,a);}}
  if(!pose)pose={yaw:newYaw,pitch:newPitch};
  else{pose.yaw=lerp(pose.yaw,newYaw,.28);pose.pitch=lerp(pose.pitch,newPitch,.28);}
  lastFaceAt=t;
 }catch(e){if(t-lastFaceAt>1300){trackedLandmarks=null;pose=null;}}
}
function projectVideoPoint(p,w,h){
 const vw=video.videoWidth||w,vh=video.videoHeight||h,scale=Math.max(w/vw,h/vh);
 const px=p.x*vw*scale+(w-vw*scale)/2,py=p.y*vh*scale+(h-vh*scale)/2;
 return pt(w-px,py);
}
function demoPoint(x,y,w,h){const scale=Math.max(w/800,h/680);return pt(x*scale+(w-800*scale)/2,y*scale+(h-680*scale)/2);}
const FACE_OVAL=[10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
function getFace(w,h,t){
 if(stream&&mode==='face'){
  if(!trackedLandmarks||t-lastFaceAt>1250)return null;
  const P=i=>projectVideoPoint(trackedLandmarks[i],w,h);
  const eyeL=P(33),eyeR=P(263),center=midpoint(P(234),P(454));
  const sides=[P(234),P(454)].sort((a,b)=>a.x-b.x);
  const eyePair=[eyeL,eyeR].sort((a,b)=>a.x-b.x);
  const roll=Math.atan2(eyePair[1].y-eyePair[0].y,eyePair[1].x-eyePair[0].x);
  return {center,width:distance(...sides),eye:midpoint(eyeL,eyeR),top:P(10),chin:P(152),nose:P(1),roll,yaw:pose?.yaw||0,pitch:pose?.pitch||0,
    oval:FACE_OVAL.map(P),live:true};
 }
 if(stream)return null;
 const P=(x,y)=>demoPoint(x,y,w,h),center=P(400,339);
 return {center,width:distance(P(268,339),P(532,339)),eye:P(400,320),top:P(400,110),chin:P(400,512),nose:P(400,367),roll:0,yaw:0,pitch:0,
  oval:[P(400,108),P(460,119),P(509,160),P(530,241),P(529,337),P(518,405),P(493,458),P(452,500),P(400,520),P(347,500),P(304,458),P(281,402),P(268,337),P(270,239),P(291,161),P(339,117)],live:false};
}
function getAssets(w,h){
 if(w===offscreenW&&h===offscreenH)return;
 offscreenW=w;offscreenH=h;
 light=document.createElement('canvas');mask=document.createElement('canvas');
 for(const c of [light,mask]){c.width=Math.max(1,Math.round(w));c.height=Math.max(1,Math.round(h));}
}
function photoOrDemo(w,h){
 if(stream&&video.readyState>=2){
  const vw=video.videoWidth,vh=video.videoHeight,scale=Math.max(w/vw,h/vh),dw=vw*scale,dh=vh*scale;
  ctx.save();if(mode==='face'){ctx.translate(w,0);ctx.scale(-1,1);}ctx.drawImage(video,(w-dw)/2,(h-dh)/2,dw,dh);ctx.restore();return;
 }
 const img=mode==='face'?sampleFaceImg:samplePovImg;
 if(img){const fit=Math.max(w/800,h/680);ctx.drawImage(img,(w-800*fit)/2,(h-680*fit)/2,800*fit,680*fit);}
 else{ctx.fillStyle='#282334';ctx.fillRect(0,0,w,h);}
}
function bodyDiffuse(face,w,h,t){
 const power=settings.brightness/100*(animate?(.86+.14*Math.sin(t*.001*(.4+settings.speed/35))):1);
 if(power<=0)return;
 const fc=light.getContext('2d'),mc=mask.getContext('2d');
 fc.clearRect(0,0,w,h);mc.clearRect(0,0,w,h);
 // Face-outline alpha mask softened at the edges. No illumination on the wall.
 mc.save();mc.filter=`blur(${Math.max(2.5,face.width*(.012+settings.softness/600))}px)`;
 mc.beginPath();face.oval.forEach((p,i)=>i?mc.lineTo(p.x,p.y):mc.moveTo(p.x,p.y));mc.closePath();mc.fillStyle='white';mc.fill();mc.restore();
 const brim=pt(lerp(face.top.x,face.eye.x,.34),lerp(face.top.y,face.eye.y,.34));
 fc.save();fc.translate(brim.x,brim.y);fc.rotate(face.roll);
 const fw=face.width,reach=lerp(.70,1.58,settings.vertical/100);
 const lightHeight=fw*reach;
 const hue=settings.hue,sat=settings.saturation;
 // A large, nearly flat field of downward incident light across the face.
 // No ellipses, radial gradients, spots or peak points on the cheeks.
 const g=fc.createLinearGradient(0,-fw*.14,0,lightHeight);
 const weight=.49+settings.ambient/100*.15;
 g.addColorStop(0,`hsla(${hue},${sat}%,${52+settings.ambient*.13}%,0)`);
 g.addColorStop(.12,`hsla(${hue},${sat}%,${52+settings.ambient*.13}%,${weight*.84})`);
 g.addColorStop(.30,`hsla(${hue},${sat}%,${52+settings.ambient*.13}%,${weight})`);
 g.addColorStop(.50,`hsla(${hue},${sat}%,${50+settings.ambient*.13}%,${weight*.95})`);
 g.addColorStop(.72,`hsla(${hue},${sat}%,${48+settings.ambient*.13}%,${weight*.58})`);
 g.addColorStop(1,`hsla(${hue},${sat}%,${48+settings.ambient*.13}%,0)`);
 fc.fillStyle=g;
 const range=fw*(.40+settings.size/100*.51);
 fc.fillRect(-range,-fw*.14,2*range,lightHeight+fw*.14);
 // Wide lateral roll-off and yaw-aware exposure; softened continuously.
 fc.globalCompositeOperation='destination-in';
 const side=fc.createLinearGradient(-range,0,range,0);
 const yawBias=face.yaw*.24,span=.22+settings.gap/100*.28;
 side.addColorStop(0,'rgba(255,255,255,0)');
 side.addColorStop(clamp(.5-span+yawBias,.08,.38),'rgba(255,255,255,.98)');
 side.addColorStop(clamp(.5+span+yawBias,.62,.92),'rgba(255,255,255,.98)');
 side.addColorStop(1,'rgba(255,255,255,0)');
 fc.fillStyle=side;fc.fillRect(-range,-fw*.2,range*2,lightHeight+fw*.3);
 fc.restore();
 fc.save();fc.globalCompositeOperation='destination-in';fc.drawImage(mask,0,0);fc.restore();
 // Color reacts to existing skin luminance and shadows, rather than covering
 // it with a transparent graphic. Two gentle passes mimic diffuse reflected LED.
 ctx.save();ctx.globalCompositeOperation='soft-light';ctx.globalAlpha=clamp(power*.97,0,1);ctx.drawImage(light,0,0,w,h);
 ctx.globalCompositeOperation='screen';ctx.globalAlpha=clamp(power*(.31+settings.ambient/330),0,.5);ctx.drawImage(light,0,0,w,h);ctx.restore();
}
function drawBrimShadow(face){
 if(!hatVisible)return;
 const fw=face.width,brim=pt(lerp(face.top.x,face.eye.x,.34),lerp(face.top.y,face.eye.y,.34));
 ctx.save();ctx.translate(brim.x,brim.y);ctx.rotate(face.roll);
 const gr=ctx.createLinearGradient(0,-fw*.06,0,fw*.47);
 gr.addColorStop(0,'rgba(10,9,17,.35)');gr.addColorStop(.22,'rgba(10,9,17,.23)');gr.addColorStop(1,'rgba(10,9,17,0)');
 ctx.beginPath();ctx.moveTo(-fw*.52,0);ctx.quadraticCurveTo(0,fw*.035,fw*.52,0);ctx.lineTo(fw*.42,fw*.45);ctx.lineTo(-fw*.42,fw*.45);ctx.closePath();
 ctx.fillStyle=gr;ctx.fill();ctx.restore();
}
// Projection of a lightweight 3D cap: the cap, seams, brim thickness and LEDs
// all rotate in yaw, pitch and roll around the actual tracked forehead.
function drawHat(face){
 const W=face.width*settings.hatScale/100;
 if(W<20)return;
 const anchor=pt(lerp(face.top.x,face.eye.x,.32),lerp(face.top.y,face.eye.y,.32));
 const yaw=face.yaw,pitch=face.pitch+settings.hatTilt*Math.PI/180,roll=face.roll;
 const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch),cr=Math.cos(roll),sr=Math.sin(roll);
 function P(x,y,z){
  const xx=x*cy+z*sy,zz=z*cy-x*sy;
  const yy=y*cp-zz*sp,depth=y*sp+zz*cp;
  const perspective=clamp(1/(1-depth*.62),.63,1.58);
  return pt(anchor.x+(xx*cr-yy*sr)*W*perspective,anchor.y+(xx*sr+yy*cr)*W*perspective);
 }
 const quad=(a,b,c,d)=>{ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.lineTo(c.x,c.y);ctx.lineTo(d.x,d.y);ctx.closePath();};
 const samples=Array.from({length:33},(_,i)=>-1+i/16);
 const crownTop=s=>P(.53*s,-.53+.20*s*s,.04+.055*(1-s*s));
 const crownBottom=s=>P(.57*s,-.024+.043*s*s,.11+.058*(1-s*s));
 const top=samples.map(crownTop),bottom=samples.map(crownBottom);
 ctx.save();ctx.shadowColor='rgba(5,4,10,.38)';ctx.shadowBlur=W*.09;ctx.shadowOffsetY=W*.025;
 ctx.beginPath();top.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));bottom.slice().reverse().forEach(p=>ctx.lineTo(p.x,p.y));ctx.closePath();
 const topCenter=crownTop(0),lowerCenter=crownBottom(0),shade=ctx.createLinearGradient(topCenter.x-W*.42,topCenter.y-W*.30,lowerCenter.x+W*.35,lowerCenter.y+W*.1);
 shade.addColorStop(0,'#5c5367');shade.addColorStop(.30,'#403a4b');shade.addColorStop(.64,'#272633');shade.addColorStop(1,'#151720');
 ctx.fillStyle=shade;ctx.fill();ctx.shadowBlur=0;ctx.shadowOffsetY=0;
 // Fabric side panels: tiny tonal changes mimic curved textile, not cartoon outlines.
 for(const s of [-.53,.47]){
  const a=crownTop(s),b=crownBottom(s),control=P(s*.48,-.31,.12);
  ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.quadraticCurveTo(control.x,control.y,b.x,b.y);
  ctx.lineWidth=Math.max(.8,W*.0038);ctx.strokeStyle='rgba(214,199,225,.18)';ctx.stroke();
 }
 const line=ctx.createLinearGradient(topCenter.x,topCenter.y,lowerCenter.x,lowerCenter.y);
 line.addColorStop(0,'rgba(243,232,246,.27)');line.addColorStop(1,'rgba(243,232,246,.05)');
 ctx.beginPath();ctx.moveTo(topCenter.x,topCenter.y);ctx.quadraticCurveTo(...Object.values(P(-.035,-.19,.16)),lowerCenter.x,lowerCenter.y);
 ctx.lineWidth=Math.max(.8,W*.003);ctx.strokeStyle=line;ctx.stroke();
 // Brim is a 3D front-projecting surface. Its front edge stays perspective-correct
 // as the face turns, including when one side becomes visibly narrower.
 const back=s=>P(.59*s,-.012+.026*s*s,.15+.016*(1-s*s));
 const front=s=>P(.64*s,.080+.012*s*s,.24+.26*(1-s*s));
 const frontLow=s=>P(.64*s,.099+.012*s*s,.24+.26*(1-s*s));
 const rearPts=samples.map(back),frontPts=samples.map(front),edgePts=samples.map(frontLow);
 const under=ctx.createLinearGradient(...Object.values(back(0)),...Object.values(frontLow(0)));
 under.addColorStop(0,'#565064');under.addColorStop(.48,'#292938');under.addColorStop(1,'#121723');
 ctx.beginPath();rearPts.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));frontPts.slice().reverse().forEach(p=>ctx.lineTo(p.x,p.y));ctx.closePath();ctx.fillStyle=under;ctx.fill();
 ctx.beginPath();frontPts.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));edgePts.slice().reverse().forEach(p=>ctx.lineTo(p.x,p.y));ctx.closePath();ctx.fillStyle='#171822';ctx.fill();
 ctx.beginPath();frontPts.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.strokeStyle='rgba(187,169,199,.50)';ctx.lineWidth=Math.max(.85,W*.004);ctx.stroke();
 // Thin inset brim seam.
 ctx.beginPath();samples.forEach((s,i)=>{const q=P(.624*s,.068+.01*s*s,.23+.236*(1-s*s));i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);});ctx.lineWidth=Math.max(.7,W*.0024);ctx.strokeStyle='rgba(241,232,245,.19)';ctx.stroke();
 // Discreet front emblem.
 const logo=P(0,-.232,.142);ctx.save();ctx.translate(logo.x,logo.y);ctx.rotate(roll);
 ctx.fillStyle='rgba(239,222,248,.79)';ctx.font=`650 ${Math.max(9,W*.076)}px ui-sans-serif,system-ui,sans-serif`;ctx.textAlign='center';ctx.fillText('lura',0,0);ctx.restore();
 // Subtle integrated LED strip is placed under brim: it always emits down.
 const power=settings.brightness/100;
 for(const side of [-1,1]){
  const a=P(side*.225,.073,.351),b=P(side*.40,.080,.310);
  ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);
  ctx.lineWidth=Math.max(1.25,W*.015);ctx.lineCap='round';
  ctx.strokeStyle=`hsla(${settings.hue},${settings.saturation}%,79%,${.15+.45*power})`;
  ctx.shadowColor=`hsl(${settings.hue},${settings.saturation}%,65%)`;ctx.shadowBlur=W*.024*power;ctx.stroke();ctx.shadowBlur=0;
 }
 ctx.restore();
}
function drawPov(w,h,t){
 const pulse=animate?(.86+.14*Math.sin(t*.001*(.4+settings.speed/35))):1;
 const power=settings.brightness/100*pulse;
 if(!power)return;
 const g=ctx.createLinearGradient(0,h*.45,0,h*1.1),color=`${settings.hue},${settings.saturation}%`;
 g.addColorStop(0,`hsla(${color},62%,0)`);g.addColorStop(.55,`hsla(${color},60%,${power*.055})`);g.addColorStop(1,`hsla(${color},65%,${power*.20})`);
 ctx.save();ctx.globalCompositeOperation='screen';ctx.fillStyle=g;ctx.fillRect(0,0,w,h);ctx.restore();
}
function paint(t){
 const bounds=preview.getBoundingClientRect(),w=bounds.width,h=bounds.height;
 const dpr=Math.min(devicePixelRatio||1,mobile?1.4:2);
 const CW=Math.round(w*dpr),CH=Math.round(h*dpr);
 if(canvas.width!==CW||canvas.height!==CH){canvas.width=CW;canvas.height=CH;}
 ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
 photoOrDemo(w,h);getAssets(w,h);
 if(mode==='face'){
  updateTracking(t);
  const face=getFace(w,h,t);
  if(face){bodyDiffuse(face,w,h,t);drawBrimShadow(face);if(hatVisible)drawHat(face);}
 }else drawPov(w,h,t);
 if(t-lastFrameAt>350){updateHint();lastFrameAt=t;}
 frameId=requestAnimationFrame(paint);
}
function imageFromSVG(el){return new Promise((resolve,reject)=>{
 const xml=new XMLSerializer().serializeToString(el);const blob=new Blob([xml],{type:'image/svg+xml;charset=utf-8'});const url=URL.createObjectURL(blob),img=new Image();
 img.onload=()=>{URL.revokeObjectURL(url);resolve(img);};img.onerror=()=>{URL.revokeObjectURL(url);reject(Error('Cannot render illustration'));};img.src=url;
});}
imageFromSVG($('demoFace')).then(im=>sampleFaceImg=im).catch(()=>{});
imageFromSVG($('demoPov')).then(im=>samplePovImg=im).catch(()=>{});
$('snapshotBtn').addEventListener('click',()=>{
 try{
  const a=document.createElement('a');a.href=canvas.toDataURL('image/png');a.download=`lura-${mode}-${hatVisible?'with-hat':'without-hat'}.png`;
  document.body.append(a);a.click();a.remove();
 }catch(e){$('cameraInfo').textContent='Could not capture this frame. Try again.';}
});
window.addEventListener('pagehide',()=>{stopCamera();cancelAnimationFrame(frameId);if(tracker?.close)tracker.close();});
frameId=requestAnimationFrame(paint);
})();
