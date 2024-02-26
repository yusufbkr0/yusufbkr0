list_method=[]
for method in dir(list):
    if method.startswith("__"):
      continue
    list_method.append(method)
    
print(list_method)  

set_method=[]
for method in dir(set):
    if method.startswith("__"):
      continue
    set_method.append(method)
    
print(set_method,end="\n")  
string_method=[]
for method in dir(str):
    if method.startswith("__"):
      continue
    string_method.append(method)
    
print(string_method)  

tuple_method=[]
for method in dir(tuple):
    if method.startswith("__"):
      continue
    tuple_method.append(method)
    
print(tuple_method) 

dict_method=[]
for method in dir(dict):
    if method.startswith("__"):
      continue
    dict_method.append(method)
    
print(dict_method)  
basliklar =[" list method","sets","string","tuple","dict"]
classes=[list_method,set_method,string_method,tuple_method,dict_method]
max_len=0
for classs in classes:
   if len(classs)>max_len:
      max_len=len(classs)
with open(r"C:\Users\LENOVO\Desktop\python\example.text","w")  as file: 
    for baslik in basliklar:
      print(baslik,end="")
      print(" "*(30-len(baslik)),end="")
      file.write(baslik)
      file.write(" "*(30-len(baslik)))
    for i in range(max_len):
        print()
        file.write("\n")
        for classs in classes:
        
           if i>= len(classs):
               print("-------",end="")
               print(" "*23,end="")
               file.write("-------")
               file.write(" "*23)
           else:
              print(classs[i],end="")
              print(" "*(30-len(classs[i])),end="")
              file.write(classs[i])
              file.write(" "*(30-len(classs[i])))
        

   


