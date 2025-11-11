// go run chain_analyzer.go -h1=917000 -h2=917696 -browser
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"html/template"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// ==================== 默认配置 ====================
var defaultConfig = struct {
	Node string
	User string
	Pass string
}{
	Node: "http://127.0.0.1:8332",
	User: "username",
	Pass: "randompasswd",
}

// ==================== 结构体 ====================
type Config struct {
	H1   int
	H2   int
	Node string
	User string
	Pass string
}

// ==================== 日志文件 ====================
var logFile *os.File

func initLog() error {
	var err error
	logFile, err = os.OpenFile("analyzer.log", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("无法创建日志文件: %w", err)
	}
	return nil
}

func logf(format string, args ...interface{}) {
	if logFile != nil {
		fmt.Fprintf(logFile, format+"\n", args...)
		logFile.Sync() // 立即刷新到磁盘，避免缓冲问题
	}
}

func closeLog() {
	if logFile != nil {
		logFile.Close()
	}
}

type RPCRequest struct {
	JSONRPC string        `json:"jsonrpc"`
	Method  string        `json:"method"`
	Params  []interface{} `json:"params"`
	ID      int           `json:"id"`
}

type RPCResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	ID int `json:"id"`
}

type BlockHeader struct {
	Time int64 `json:"time"`
}

type Point struct {
	X       int64   `json:"x"`       // Unix时间戳
	Y       float64 `json:"y"`       // 归一化的速率
	Diff    int64   `json:"diff"`    // 时间间隔（秒）
	Time    string  `json:"time"`    // 格式化的时间
	Height  int     `json:"height"`  // 区块高度
	Zero    bool    `json:"zero"`    // 是否异常值
}

func main() {
	cfg := Config{
		Node: defaultConfig.Node,
		User: defaultConfig.User,
		Pass: defaultConfig.Pass,
	}

	flag.IntVar(&cfg.H1, "h1", 0, "起始高度")
	flag.IntVar(&cfg.H2, "h2", 0, "结束高度")
	flag.StringVar(&cfg.Node, "node", cfg.Node, "RPC 节点地址")
	flag.StringVar(&cfg.User, "user", cfg.User, "RPC 用户名")
	flag.StringVar(&cfg.Pass, "pass", cfg.Pass, "RPC 密码")
	var browser bool
	flag.BoolVar(&browser, "browser", false, "自动打开浏览器")
	flag.Parse()

	if cfg.H1 >= cfg.H2 || cfg.H1 < 0 {
		fmt.Println("用法: go run chain_analyzer.go -h1=917000 -h2=917696")
		return
	}

	// 初始化日志文件
	if err := initLog(); err != nil {
		fmt.Printf("警告: %v\n", err)
	} else {
		defer closeLog()
		fmt.Println("日志文件已创建: analyzer.log")
	}

	fmt.Printf("正在分析区块 %d → %d...\n", cfg.H1, cfg.H2)

	timestamps, err := getBlockTimestamps(cfg)
	fmt.Println() // 进度显示后换行
	if err != nil {
		fmt.Printf("错误: %v\n", err)
		return
	}

	// === 1. 计算所有间隔（包含 0）===
	diffs := make([]int64, len(timestamps)-1)
	negativeCount := 0
	negativeTotalTime := int64(0)
	for i := 1; i < len(timestamps); i++ {
		diff := timestamps[i] - timestamps[i-1]
		diffs[i-1] = diff
		if diff < 0 {
			negativeCount++
			negativeTotalTime += -diff // 累计倒退的时间（取绝对值）
			logf("警告: 高度 %d → %d 时间倒退 %d 秒 (从 %s 到 %s)",
				cfg.H1+i-1, cfg.H1+i, -diff,
				formatTime(timestamps[i-1]), formatTime(timestamps[i]))
		}
	}

	// === 2. 基础统计（包含 0 间隔）===
	totalDuration := timestamps[len(timestamps)-1] - timestamps[0]
	intervalCount := int64(len(diffs))
	avgInterval := float64(totalDuration) / float64(intervalCount)
	ratePerHour := float64(intervalCount) * 3600 / float64(totalDuration)

	// 正值用于最长/众数
	var positiveDiffs []int64
	for _, d := range diffs {
		if d > 0 {
			positiveDiffs = append(positiveDiffs, d)
		}
	}
	maxDiff := int64(0)
	if len(positiveDiffs) > 0 {
		maxDiff = max(positiveDiffs)
	}
	modes := findModes(diffs)
	positiveModes := findModes(positiveDiffs)

	// === 3. 统一平方根归一化（只计算一次）===
	normalizedData, minSqrt, maxSqrt := normalizeSqrtRate(diffs)

	// === 4. 终端速率曲线图 ===
	drawRateChart(normalizedData, timestamps, cfg.H1, cfg.H2)

	// === 5. 智能速率区间分析 ===
	report := smartRateAnalysis(diffs, avgInterval, timestamps, cfg.H1)

	// === 6. 输出报告 ===
	printSmartReport(cfg.H1, cfg.H2, totalDuration, avgInterval, ratePerHour, maxDiff, modes, positiveModes, negativeCount, negativeTotalTime, report)

	// === 7. 生成 HTML 报告 ===
	htmlPath := generateHTMLReport(cfg.H1, cfg.H2, timestamps, diffs, normalizedData, avgInterval, minSqrt, maxSqrt)
	fmt.Printf("HTML 报告已生成：%s\n", htmlPath)

	if browser {
		_ = openBrowser("file://" + htmlPath)
	}
}

// ====================== 统一归一化函数 ======================
// normalizeSqrtRate 使用平方根变换进行归一化
// 关键：d <= 0 的数据用 110.0 占位，不参与 min/max 计算，但保持索引对应
func normalizeSqrtRate(diffs []int64) (normalized []float64, minSqrt, maxSqrt float64) {
	// 1. 只收集正常数据的 sqrt(rate) 用于计算 min/max
	var sqrtRates []float64
	for _, d := range diffs {
		if d > 0 {
			r := 3600.0 / float64(d)
			sqrtRates = append(sqrtRates, math.Sqrt(r))
		}
	}
	
	// 2. 计算正常数据的范围
	sort.Float64s(sqrtRates)
	minSqrt, maxSqrt = 0.0, 1.0
	if len(sqrtRates) > 0 {
		minSqrt = sqrtRates[0]
		maxSqrt = sqrtRates[len(sqrtRates)-1]
	}
	rangeSqrt := maxSqrt - minSqrt
	if rangeSqrt == 0 {
		rangeSqrt = 1
	}
	
	// 3. 归一化所有数据（包括异常值）
	normalized = make([]float64, len(diffs))
	for i, d := range diffs {
		if d <= 0 {
			normalized[i] = 110.0 // 异常值占位：100 + 10
		} else {
			r := 3600.0 / float64(d)
			sqrtR := math.Sqrt(r)
			normalized[i] = (sqrtR - minSqrt) / rangeSqrt * 100.0
		}
	}
	
	return normalized, minSqrt, maxSqrt
}

// ====================== 终端图 ======================
func drawRateChart(normalizedData []float64, timestamps []int64, h1, h2 int) {
	const width = 80
	const height = 15
	chart := make([][]rune, height)
	for i := range chart {
		chart[i] = make([]rune, width)
		for j := range chart[i] {
			chart[i][j] = ' '
		}
	}

	// ---------- 计算时间范围（x轴：时间轴）----------
	minTime := timestamps[0]
	maxTime := timestamps[len(timestamps)-1] + 180 // 最后一个块 + 3分钟
	timeRange := maxTime - minTime
	
	// ---------- 绘制（使用时间轴映射）----------
	for i, yNorm := range normalizedData {
		// 计算每个点在时间轴上的位置
		pointTime := timestamps[i+1] // normalizedData[i] 对应第 i+1 个块
		x := int(float64(pointTime-minTime) / float64(timeRange) * float64(width-1))
		if x < 0 {
			x = 0
		}
		if x >= width {
			x = width - 1
		}
		
		y := int((100.0 - yNorm) / 100.0 * float64(height-2))
		if y < 0 {
			y = 0
		}
		if y >= height-1 {
			y = height - 2
		}
		
		// 异常值用星号标记
		char := '█'
		if yNorm >= 110.0 {
			char = '*'
		}
		chart[y][x] = char
	}

	// ---------- X 轴刻度：显示时间 ----------
	positions := []int{0, width / 4, width / 2, 3 * width / 4, width - 1}
	for _, x := range positions {
		// 计算该位置对应的时间戳
		timestamp := minTime + int64(float64(timeRange)*float64(x)/float64(width-1))
		// 格式化为简短时间（月-日 时:分）
		t := time.Unix(timestamp, 0)
		label := t.Format("01-02 15:04")
		
		start := x - len(label)/2
		if start < 0 {
			start = 0
		}
		if start+len(label) > width {
			start = width - len(label)
		}
		copy(chart[height-1][start:], []rune(label))
	}

	fmt.Printf("\n出块速率曲线图 (√归一化 0-100，异常值偏移至 110)\n")
	fmt.Printf("※ '*' = 异常出块（0秒或负数，高出 10） | X轴：时间轴\n")
	for _, row := range chart {
		fmt.Printf("%s\n", string(row))
	}
	fmt.Printf("↑ 高速率 ← 时间 → ↓ 低速率\n")
}

// ====================== HTML 报告 ======================
func generateHTMLReport(h1, h2 int, timestamps, diffs []int64, normalizedData []float64, avgInterval, minSqrt, maxSqrt float64) string {
	var data []Point
	var colors []string

	// ---------- 计算平均速率的归一化 Y ----------
	avgRate := 3600.0 / avgInterval
	avgSqrt := math.Sqrt(avgRate)
	rangeSqrt := maxSqrt - minSqrt
	if rangeSqrt == 0 {
		rangeSqrt = 1
	}
	avgY := (avgSqrt - minSqrt) / rangeSqrt * 100.0

	// ---------- 构造点（使用时间轴）----------
	for i := 1; i < len(timestamps); i++ {
		diff := diffs[i-1]
		y := normalizedData[i-1]
		isZero := diff <= 0
		color := getColor(diff, avgInterval)
		colors = append(colors, color)

		data = append(data, Point{
			X:      timestamps[i],           // X轴：时间戳
			Y:      y,
			Diff:   diff,
			Time:   formatTime(timestamps[i]),
			Height: h1 + i,                  // 保留区块高度用于tooltip
			Zero:   isZero,
		})
	}

	totalDuration := timestamps[len(timestamps)-1] - timestamps[0]
	ratePerHour := float64(len(diffs)) * 3600 / float64(totalDuration)

	// ---------- 常量定义 ----------
	const zeroY = 110.0 // 异常值显示位置

	// ---------- X 轴范围：时间轴 ----------
	minX := timestamps[0]
	maxX := timestamps[len(timestamps)-1] + 180 // 最后一个块 + 3分钟
	timeRange := maxX - minX
	stepSize := float64(timeRange) / 6 // 分成6段，显示更多刻度

	const htmlTemplate = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>出块速率分析报告 [{{.H1}} → {{.H2}}]</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body{font-family:system-ui,sans-serif;margin:20px;background:#f9f9fb;}
    .container{max-width:1200px;margin:auto;background:white;padding:20px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);}
    h1{color:#2c3e50;text-align:center;}
    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:15px;margin:20px 0;}
    .stat{background:#eef5ff;padding:15px;border-radius:8px;text-align:center;}
    .stat strong{display:block;font-size:1.5em;color:#3498db;}
    canvas{border:1px solid #ddd;border-radius:8px;margin:20px 0;}
    .footer{text-align:center;margin-top:30px;color:#7f8c8d;font-size:0.9em;}
    .legend{margin:10px 0;font-size:0.9em;color:#e74c3c;}
  </style>
</head>
<body>
  <div class="container">
    <h1>出块速率分析报告 [{{.H1}} → {{.H2}}]</h1>

    <div class="stats">
      <div class="stat"><strong>{{.BlockCount}}</strong> 总区块数</div>
      <div class="stat"><strong>{{.Duration}}</strong> 总时长</div>
      <div class="stat"><strong>{{printf "%.2f" .AvgInterval}} 秒</strong> 平均出块时间</div>
      <div class="stat"><strong>{{printf "%.2f" .RatePerHour}} 块/小时</strong> 出块速率</div>
    </div>

    <div class="legend">Warning: 红色星号 = 异常出块（0秒或负数，归一化后 100 + 10）</div>

    <canvas id="rateChart" width="1200" height="360"></canvas>

    <div class="footer">生成时间: {{.Now}} | 工具: chain_analyzer (Go)</div>
  </div>

  <script>
    const ctx = document.getElementById('rateChart').getContext('2d');
    const data = {{.JSONData}};
    const colors = {{.Colors}};
    const zeroY = {{.ZeroY}};
    const avgY = {{.AvgY}};
    const minSqrt = {{.MinSqrt}};
    const maxSqrt = {{.MaxSqrt}};

    new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [
          {
            type: 'line',
            label: '平均出块速率',
            data: [{x: {{.MinX}}, y: avgY}, {x: {{.MaxX}}, y: avgY}],
            borderColor: '#27ae60',
            borderDash: [6, 4],
            borderWidth: 2,
            pointRadius: 0,
            fill: false
          },
          {
            label: '出块速率 (√归一化)',
            data: data,
            backgroundColor: ctx => ctx.raw.zero ? '#e74c3c' : colors[ctx.dataIndex],
            pointRadius: ctx => ctx.raw.zero ? 7 : 3,
            pointStyle: ctx => ctx.raw.zero ? 'star' : 'circle',
            pointHoverRadius: ctx => ctx.raw.zero ? 10 : 5,
            showLine: false
          }
        ]
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
		animation: { duration: 0 },
        plugins: {
          tooltip: {
            callbacks: {
              title: ctx => {
                const r = ctx[0].raw;
                return '高度: ' + r.height + ' | 时间: ' + r.time;
              },
              label: ctx => {
                const r = ctx.raw;
                if (ctx.datasetIndex === 0) {
                  return [
                    '平均出块时间: {{printf "%.2f" .AvgInterval}} 秒',
                    '归一化 Y: ' + avgY.toFixed(1)
                  ];
                }
                if (r.zero) {
                  return [
                    'Warning: 异常出块！',
                    '显示值: ' + zeroY.toFixed(1),
                    '实际间隔: ' + r.diff + ' 秒'
                  ];
                } else {
                  const sqrtY = r.y / 100 * (maxSqrt - minSqrt) + minSqrt;
                  const realRate = sqrtY * sqrtY;
                  return [
                    '归一化(√): ' + r.y.toFixed(1),
                    '实际速率: ' + realRate.toFixed(2) + ' 块/小时',
                    '间隔: ' + r.diff + ' 秒'
                  ];
                }
              }
            }
          },
          title: {display:true, text:'出块速率（√归一化 0-100，异常值偏移至 110） | X轴：时间轴', font:{size:13}}
        },
        scales: {
          x: {
            type: 'linear',
            min: {{.MinX}},
            max: {{.MaxX}},
            title: {display:true, text:'时间'},
            ticks: {
              stepSize: {{.StepSize}},
              callback: v => {
                const d = new Date(v * 1000);
                return d.getMonth()+1 + '-' + d.getDate() + ' ' + 
                       String(d.getHours()).padStart(2,'0') + ':' + 
                       String(d.getMinutes()).padStart(2,'0');
              },
              font: {size: 10}
            },
            grid: {lineWidth: 0.5}
          },
          y: {
            title: {display:true, text:'归一化速率 (√)'},
            min: 0,
            max: 120,
            ticks: {
              font: {size: 10}
            },
            grid: {lineWidth: 0.5}
          }
        }
      }
    });
  </script>
</body>
</html>
`

	type TemplateData struct {
		H1          int
		H2          int
		BlockCount  int
		Duration    string
		AvgInterval float64
		RatePerHour float64
		JSONData    template.JS
		Colors      template.JS
		ZeroY       float64
		AvgY        float64
		MinSqrt     float64
		MaxSqrt     float64
		MinX        int64       // X轴最小值（时间戳）
		MaxX        int64       // X轴最大值（时间戳）
		StepSize    float64
		Now         string
	}

	tmpl := template.Must(template.New("report").Funcs(template.FuncMap{
		"printf": fmt.Sprintf,
	}).Parse(htmlTemplate))

	jsonData, err := json.Marshal(data)
	if err != nil {
		fmt.Printf("警告: JSON 数据序列化失败: %v\n", err)
	}
	jsonColors, err := json.Marshal(colors)
	if err != nil {
		fmt.Printf("警告: 颜色数据序列化失败: %v\n", err)
	}

	dir, err := os.UserCacheDir()
	if err != nil || dir == "" {
		dir = "."
		fmt.Printf("警告: 无法获取缓存目录，使用当前目录: %v\n", err)
	}
	path := filepath.Join(dir, fmt.Sprintf("chain_report_%d_%d.html", h1, h2))
	fmt.Printf("正在生成 HTML 报告到: %s\n", path)
	
	f, err := os.Create(path)
	if err != nil {
		fmt.Printf("错误: 无法创建文件 %s: %v\n", path, err)
		return path
	}
	defer f.Close()

	err = tmpl.Execute(f, TemplateData{
		H1:          h1,
		H2:          h2,
		BlockCount:  h2 - h1 + 1,
		Duration:    (time.Duration(totalDuration) * time.Second).String(),
		AvgInterval: avgInterval,
		RatePerHour: ratePerHour,
		JSONData:    template.JS(jsonData),
		Colors:      template.JS(jsonColors),
		ZeroY:       zeroY,
		AvgY:        avgY,
		MinSqrt:     minSqrt,
		MaxSqrt:     maxSqrt,
		MinX:        minX,
		MaxX:        maxX,
		StepSize:    stepSize,
		Now:         time.Now().Format("2006-01-02 15:04:05"),
	})
	
	if err != nil {
		fmt.Printf("错误: 模板执行失败: %v\n", err)
	} else {
		fmt.Printf("HTML 报告生成成功\n")
	}

	return path
}

// ====================== 其余不变 ======================
func getColor(diff int64, avg float64) string {
	if diff <= 0 {
		return "#e74c3c"
	}
	ratio := float64(diff) / avg
	if ratio <= 0.5 {
		return "#e74c3c"
	} else if ratio <= 1.5 {
		return "#27ae60"
	}
	return "#3498db"
}

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}

// ----------------- RPC & 统计 -----------------
func getBlockTimestamps(cfg Config) ([]int64, error) {
	timestamps := make([]int64, 0, cfg.H2-cfg.H1+1)
	client := &http.Client{Timeout: 30 * time.Second}
	for height := cfg.H1; height <= cfg.H2; height++ {
		hash, err := rpcCall(cfg, client, "getblockhash", []interface{}{height})
		if err != nil {
			return nil, fmt.Errorf("getblockhash %d: %w", height, err)
		}
		headerJSON, err := rpcCall(cfg, client, "getblockheader", []interface{}{hash})
		if err != nil {
			return nil, fmt.Errorf("getblockheader %s: %w", hash, err)
		}
		var header BlockHeader
		if err := json.Unmarshal(headerJSON, &header); err != nil {
			return nil, fmt.Errorf("解析 header: %w", err)
		}
		timestamps = append(timestamps, header.Time)
		
		// === 记录高度 + 时间戳 到 analyzer.log ===
		logf("高度: %d | 时间: %s (Unix: %d)",
			height,
			time.Unix(header.Time, 0).Format("2006-01-02 15:04:05"),
			header.Time,
		)
		
		if (height-cfg.H1)%100 == 0 {
			fmt.Printf("\r已处理 %d 个区块...", height-cfg.H1+1)
		}
	}
	return timestamps, nil
}

func rpcCall(cfg Config, client *http.Client, method string, params []interface{}) (json.RawMessage, error) {
	req := RPCRequest{JSONRPC: "2.0", Method: method, Params: params, ID: 1}
	body, _ := json.Marshal(req)
	httpReq, _ := http.NewRequest("POST", cfg.Node, bytes.NewBuffer(body))
	httpReq.SetBasicAuth(cfg.User, cfg.Pass)
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("连接失败: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	bodyStr := string(respBody)
	if resp.StatusCode == 401 {
		return nil, fmt.Errorf("认证失败 (401): 用户名/密码错误")
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(bodyStr, 200))
	}
	var rpcResp RPCResponse
	if err := json.Unmarshal(respBody, &rpcResp); err != nil {
		return nil, fmt.Errorf("JSON 解析失败: %w\n%s", err, truncate(bodyStr, 500))
	}
	if rpcResp.Error != nil {
		return nil, fmt.Errorf("RPC 错误 [%d]: %s", rpcResp.Error.Code, rpcResp.Error.Message)
	}
	return rpcResp.Result, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func max(data []int64) int64 {
	if len(data) == 0 {
		return 0
	}
	m := data[0]
	for _, v := range data {
		if v > m {
			m = v
		}
	}
	return m
}

// findModes 返回所有频次最高的值（可能有多个）
func findModes(data []int64) []int64 {
	if len(data) == 0 {
		return []int64{}
	}
	
	count := make(map[int64]int)
	for _, v := range data {
		count[v]++
	}
	
	// 找出最大频次
	maxCount := 0
	for _, c := range count {
		if c > maxCount {
			maxCount = c
		}
	}
	
	// 收集所有频次等于 maxCount 的值
	var modes []int64
	for v, c := range count {
		if c == maxCount {
			modes = append(modes, v)
		}
	}
	
	// 排序，确保结果确定
	sort.Slice(modes, func(i, j int) bool {
		return modes[i] < modes[j]
	})
	
	return modes
}

// formatModes 格式化众数列表为字符串
func formatModes(modes []int64) string {
	if len(modes) == 0 {
		return "无"
	}
	
	var parts []string
	for _, m := range modes {
		parts = append(parts, (time.Duration(m) * time.Second).String())
	}
	
	if len(parts) == 1 {
		return parts[0]
	}
	return strings.Join(parts, ", ") + fmt.Sprintf(" (共%d个)", len(parts))
}

func formatTime(ts int64) string {
	return time.Unix(ts, 0).Format("2006-01-02 15:04:05")
}

// ====================== 智能分析（保持不变） ======================
func smartRateAnalysis(diffs []int64, avgInterval float64, timestamps []int64, startHeight int) string {
	if len(diffs) < 10 {
		return "数据不足，无法分析"
	}
	rates := make([]float64, len(diffs))
	for i, d := range diffs {
		if d <= 0 {
			rates[i] = 1e9
		} else {
			rates[i] = 3600.0 / float64(d)
		}
	}
	sort.Float64s(rates)
	n := len(rates)
	highThresh := rates[n*7/10]
	lowThresh := rates[n*3/10]

	highStart, highEnd, highCount := findLongestRateStreak(rates, timestamps, func(r float64) bool {
		return r >= highThresh
	})
	lowStart, lowEnd, lowCount := findLongestRateStreak(rates, timestamps, func(r float64) bool {
		return r <= lowThresh && r < 1e9
	})

	total := len(diffs)
	highPct := float64(highCount) / float64(total) * 100
	lowPct := float64(lowCount) / float64(total) * 100

	var lines []string
	if highPct >= 50 {
		dur := float64(timestamps[highEnd] - timestamps[highStart])
		rate := float64(highCount) / (dur / 3600)
		lines = append(lines, fmt.Sprintf(
			"高密度出块期: %.1f%% 区块集中在 %s ~ %s (每小时 %.1f 块)",
			highPct, formatTime(timestamps[highStart]), formatTime(timestamps[highEnd]), rate,
		))
	}
	if lowPct >= 50 {
		dur := float64(timestamps[lowEnd] - timestamps[lowStart])
		rate := float64(lowCount) / (dur / 3600)
		lines = append(lines, fmt.Sprintf(
			"极稀疏出块期: %.1f%% 区块分布在 %s ~ %s (每小时 %.1f 块)",
			lowPct, formatTime(timestamps[lowStart]), formatTime(timestamps[lowEnd]), rate,
		))
	}
	if len(lines) == 0 {
		return "出块速率分布均匀"
	}
	return strings.Join(lines, "\n")
}

func findLongestRateStreak(rates []float64, timestamps []int64, condition func(float64) bool) (start, end, count int) {
	maxLen := 0
	bestStart, bestEnd := 0, 0
	for i := 0; i < len(rates); i++ {
		if condition(rates[i]) {
			j := i + 1
			for j < len(rates) && condition(rates[j]) {
				j++
			}
			if j-i > maxLen {
				maxLen = j - i
				bestStart = i
				bestEnd = j
			}
			i = j
		}
	}
	return bestStart, bestEnd, maxLen
}

func printSmartReport(h1, h2 int, total int64, avgInterval, ratePerHour float64, maxDiff int64, modes, positiveModes []int64, negativeCount int, negativeTotalTime int64, smart string) {
	fmt.Printf("出块时间分析报告 [%d → %d]\n", h1, h2)
	fmt.Printf("总区块数: %d\n", h2-h1+1)
	fmt.Printf("总时长: %s\n", time.Duration(total)*time.Second)
	fmt.Printf("平均出块时间: %.2f 秒\n", avgInterval)
	fmt.Printf("出块速率: %.2f 块/小时\n", ratePerHour)
	fmt.Printf("最长出块: %s\n", time.Duration(maxDiff)*time.Second)
	fmt.Printf("最常见间隔: %s\n", formatModes(modes))
	fmt.Printf("正数间隔的众数: %s\n", formatModes(positiveModes))
	if negativeCount > 0 {
		fmt.Printf("时间倒退的区块: %d 个\n", negativeCount)
		fmt.Printf("时间倒退的总时长: %s\n", time.Duration(negativeTotalTime)*time.Second)
	}
	fmt.Printf("\n智能速率分析:\n%s\n", smart)
}
