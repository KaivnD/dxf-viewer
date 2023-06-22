import { Pattern, RegisterPattern } from "../../Pattern"

RegisterPattern(Pattern.ParsePatFile(`
*AR-PARQ1,AR-PARQ1
90, 0,0, 12,12, 12,-12
90, 2,0, 12,12, 12,-12
90, 4,0, 12,12, 12,-12
90, 6,0, 12,12, 12,-12
90, 8,0, 12,12, 12,-12
90, 10,0, 12,12, 12,-12
90, 12,0, 12,12, 12,-12
0, 0,12, 12,-12, 12,-12
0, 0,14, 12,-12, 12,-12
0, 0,16, 12,-12, 12,-12
0, 0,18, 12,-12, 12,-12
0, 0,20, 12,-12, 12,-12
0, 0,22, 12,-12, 12,-12
0, 0,24, 12,-12, 12,-12
`), false)