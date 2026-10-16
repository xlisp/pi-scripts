// M1_color.js — PixInsight PJSR
// 对当前活动的线性 RGB 叠加图做：背景中和 → 色彩校准 → 去绿 → 拉伸(暗背景)
// → 星云掩膜 → HDRMT + LHE 去“雾”显纤维 → 星云增饱和/对比 → 反掩膜压暗背景
// 在副本 M1_proc 上处理，原图不动。
#include <pjsr/UndoFlag.jsh>

// ---------- 可调参数 ----------
var TARGET_BKG   = 0.10;  // 拉伸后背景亮度（STF 默认 0.25，越小背景越黑、核心越不容易发白）
var SHADOW_CLIP  = -2.8;  // 暗部裁切（MAD 倍数）
var SCNR_AMOUNT  = 0.5;   // 去绿强度
var HDR_LAYERS   = 6;     // HDRMT 层数：越大压得越“整体”，5~7 适合 M1
var LHE_RADIUS   = 96;
var LHE_AMOUNT   = 0.35;
var SAT_BOOST    = 0.70;  // 饱和度曲线中点 0.5 → 该值
// --------------------------------

function uniqueId(base) {
   var id = base, n = 1;
   while (!ImageWindow.windowById(id).isNull) id = base + "_" + (n++);
   return id;
}

function stats(img) {
   var n = img.numberOfChannels, med = 0, mad = 0;
   for (var c = 0; c < n; ++c) {
      img.selectedChannel = c;
      med += img.median();
      mad += img.MAD();
   }
   img.resetSelections();
   return { med: med / n, mad: 1.4826 * mad / n };
}

function curves(view, K, S) {
   var ct = new CurvesTransformation;
   if (K) ct.K = K;
   if (S) ct.S = S;
   ct.executeOn(view);
}

function main() {
   var srcWin = ImageWindow.activeWindow;
   if (srcWin.isNull) throw new Error("没有活动图像窗口");
   var src = srcWin.mainView.image;
   if (!src.isColor) throw new Error("需要 RGB 彩色图像");

   // 1. 副本
   var win = new ImageWindow(src.width, src.height, src.numberOfChannels,
                             32, true, true, uniqueId("M1_proc"));
   var view = win.mainView;
   view.beginProcess(UndoFlag_NoSwapFile);
   view.image.assign(src);
   view.endProcess();
   win.show();

   var linear = stats(view.image).med < 0.05;
   if (!linear)
      console.warningln("图像看起来已经拉伸过，跳过 BN/CC/拉伸 步骤。");

   if (linear) {
      // 2. 背景中和（去掉背景的绿/灰偏色）
      var bn = new BackgroundNeutralization;
      bn.backgroundReferenceViewId = "";
      bn.backgroundLow = 0.0;
      bn.backgroundHigh = 0.1;
      bn.executeOn(view);

      // 3. 色彩校准（整幅图作为白参考）。若已 plate-solve，可改用 SPCC 效果更好
      var cc = new ColorCalibration;
      cc.whiteReferenceViewId = "";
      cc.backgroundReferenceViewId = "";
      cc.executeOn(view);
   }

   // 4. 去绿
   var scnr = new SCNR;
   scnr.colorToRemove = SCNR.prototype.Green;
   scnr.amount = SCNR_AMOUNT;
   scnr.preserveLightness = true;
   scnr.executeOn(view);

   if (linear) {
      // 5. 链接通道的自动拉伸，但背景目标更暗
      var s = stats(view.image);
      var c0 = Math.max(0, s.med + SHADOW_CLIP * s.mad);
      var m = Math.mtf(TARGET_BKG, s.med - c0);
      var ht = new HistogramTransformation;
      ht.H = [[0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1],
              [c0, m, 1, 0, 1], [0, 0.5, 1, 0, 1]];
      ht.executeOn(view);
   }

   // 6. 星云亮度掩膜
   var bg = stats(view.image).med;
   var lo = Math.min(0.5, bg + 0.05), hi = Math.min(0.95, lo + 0.45);
   var maskId = uniqueId("M1_mask");
   var pm = new PixelMath;
   pm.expression = "max(0, min(1, (CIEL($T) - " + lo.toFixed(4) + ") / " +
                   (hi - lo).toFixed(4) + "))";
   pm.useSingleExpression = true;
   pm.createNewImage = true;
   pm.showNewImage = true;
   pm.newImageId = maskId;
   pm.newImageColorSpace = PixelMath.prototype.Gray;
   pm.newImageSampleFormat = PixelMath.prototype.f32;
   pm.rescale = false;
   pm.truncate = true;
   pm.executeOn(view);
   var maskWin = ImageWindow.windowById(maskId);

   var cv = new Convolution;
   cv.mode = Convolution.prototype.Parametric;
   cv.sigma = 8;
   cv.shape = 2;
   cv.executeOn(maskWin.mainView);

   // 7. 掩膜保护背景，只处理星云：压掉“雾”、显出纤维
   win.mask = maskWin;
   win.maskInverted = false;
   win.maskVisible = false;

   var hdr = new HDRMultiscaleTransform;
   hdr.numberOfLayers = HDR_LAYERS;
   hdr.numberOfIterations = 1;
   hdr.toLightness = true;
   hdr.preserveHue = true;
   hdr.luminanceMask = true;
   hdr.executeOn(view);

   var lhe = new LocalHistogramEqualization;
   lhe.radius = LHE_RADIUS;
   lhe.slopeLimit = 2.0;
   lhe.amount = LHE_AMOUNT;
   lhe.circularKernel = true;
   lhe.executeOn(view);

   // 星云：轻微 S 曲线增对比 + 增饱和
   curves(view, [[0, 0], [0.25, 0.20], [0.75, 0.82], [1, 1]],
                [[0, 0], [0.5, SAT_BOOST], [1, 1]]);

   // 8. 反转掩膜：压暗背景
   win.maskInverted = true;
   curves(view, [[0, 0], [0.20, 0.11], [0.60, 0.58], [1, 1]], null);

   win.removeMask();
   view.stf = [[0.5, 0, 1, 0, 1], [0.5, 0, 1, 0, 1],
               [0.5, 0, 1, 0, 1], [0.5, 0, 1, 0, 1]];
   win.zoomToFit();
   console.noteln("完成：", view.id, "（掩膜保留在 ", maskId, "，可删除或复用）");
}

main();
