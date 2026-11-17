# 页面热力浏览联合数据报告：场景与调用链验证
# 先用 esbuild 把 TS 联合域/服务打成 ESM，再用 Node 跑断言，全程不依赖浏览器。
# 本 Makefile 位于 verify/ 目录，路径均相对该目录。
.PHONY: verify

verify:
	node build-bundle.mjs
	node heat-scroll.test.mjs
	node integration.test.mjs
