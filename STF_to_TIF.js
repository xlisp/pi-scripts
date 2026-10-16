// STF_to_TIF.js — 把当前窗口的 STF 显示效果真正写进像素，并另存为 16-bit TIFF
// 用法：对图像点好 STF（Auto Stretch 并调到满意）→ 激活该窗口 → Script Editor 打开本文件按 F9
#include <pjsr/UndoFlag.jsh>

function main() {
   var win = ImageWindow.activeWindow;
   if (win.isNull) throw new Error("没有活动图像窗口");
   var view = win.mainView;
   var stf = view.stf;   // 每通道 [m, c0, c1, r0, r1]

   var id = [0, 0.5, 1, 0, 1];
   var ht = new HistogramTransformation;
   var H = [id, id, id, id, id];
   var n = view.image.isColor ? 3 : 1;
   for (var c = 0; c < n; ++c)
      H[view.image.isColor ? c : 3] = [stf[c][1], stf[c][0], stf[c][2], 0, 1];
   ht.H = H;
   ht.executeOn(view);

   // 关掉 STF，避免二次拉伸
   view.stf = [[0.5, 0, 1, 0, 1], [0.5, 0, 1, 0, 1], [0.5, 0, 1, 0, 1], [0.5, 0, 1, 0, 1]];

   // 复制到 16 位整数图像并保存
   var img = view.image;
   var out = new ImageWindow(img.width, img.height, img.numberOfChannels,
                             16, false, img.isColor, view.id + "_16bit");
   out.mainView.beginProcess(UndoFlag_NoSwapFile);
   out.mainView.image.assign(img);
   out.mainView.endProcess();

   var path = win.filePath;
   var dir = path != "" ? File.extractDrive(path) + File.extractDirectory(path) : File.homeDirectory + "/Desktop";
   var name = path != "" ? File.extractName(path) : view.id;
   var file = dir + "/" + name + "_stretched.tif";
   if (out.saveAs(file, false, false, false, false))
      console.noteln("已保存：", file);
   else
      console.criticalln("保存失败：", file);
   out.forceClose();
}

main();
